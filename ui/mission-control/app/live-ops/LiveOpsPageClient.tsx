"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import OperatorPanelGuide from "../../components/ui/OperatorPanelGuide";
import { openOpsCopilotPrompt } from "../../lib/opsCopilot";
import {
  formatSourceTreeProvenanceStatus,
  getSourceTreeCommitDeltaLines,
  normalizeSourceTreeProvenance,
} from "../../lib/sourceTreeProvenanceView";
import { UI_TERMS, formatReasonLabel } from "../../lib/uiLexicon";
import { ControlRoomMonitoringPanel, ExecutionPnlTruthMonitoringPanel, OperatorActionSummary } from "../terminal/TerminalSecondaryPanels";

type JsonMap = Record<string, unknown>;
type SystemMode = "suggest" | "guarded_auto" | "managed_live";
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

type LiveOpsPageClientProps = {
  initialLiveOpsPayload?: JsonMap | null;
};

type FetchJsonResult = {
  response: Response | null;
  payload: JsonMap | null;
};

const DAILY_PLAN_SPRINT_STORAGE_KEY = "txt.liveops.daily-plan.sprint-start.v1";
const DAILY_PLAN_CHECKS_STORAGE_KEY = "txt.liveops.daily-plan.checks.v1";
const SYSTEM_MODE_OVERRIDE_STORAGE_KEY = "txt.liveops.system-mode-override.v1";
const SYSTEM_MODE_OVERRIDE_TTL_MS = 10 * 60 * 1000;
const HYDRATION_SAFE_DATE_KEY = "1970-01-01";
const INITIAL_LIVE_OPS_CONVERGENCE_DELAY_MS = 0;
const LIVE_OPS_VISIBLE_REFRESH_MS = 20_000;
const LIVE_OPS_HIDDEN_REFRESH_MS = 60_000;
const LIVE_OPS_PRIMARY_FETCH_TIMEOUT_MS = 12_000;
const LIVE_OPS_MODE_FETCH_TIMEOUT_MS = 4_000;
const LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS = 4_000;
const LIVE_OPS_JOURNAL_CONTEXT = {
  symbol: "DESK",
  timeframe: "live",
  strategy: "live-ops",
} as const;
const DECISION_TRACE_EXPLORER_STAGES = [
  { key: "allocation", label: "Allocation", missingDetail: "Allocation canonique absente pour cette decision." },
  { key: "approval_1", label: "Approval #1", missingDetail: "Approval #1 absente ou non publiee." },
  { key: "approval_2", label: "Approval #2", missingDetail: "Approval #2 absente, en attente, ou non publiee." },
  { key: "hardening", label: "Hardening", missingDetail: "Decision de hardening absente ou non rattachee." },
  { key: "execution", label: "Execution", missingDetail: "Execution fact absent pour cette decision." },
  { key: "outcome", label: "Outcome", missingDetail: "Outcome absent ou non rattache a l execution." },
  { key: "attribution", label: "Attribution", missingDetail: "Attribution non calculee ou non publiee." },
  { key: "opportunity_cost", label: "Opportunity Cost", missingDetail: "Opportunity cost absente ou non rattachee." },
] as const;
const TRI_GOVERNANCE_RULES = [
  { label: "TRI < 30", action: "Stop developpement alpha", objective: "Continuité causale seulement", minInclusive: Number.NEGATIVE_INFINITY, maxExclusive: 30, tone: "warn" },
  { label: "TRI 30-50", action: "Reparer la continuité causale", objective: "Approval, execution, outcome, opportunity", minInclusive: 30, maxExclusive: 50, tone: "warn" },
  { label: "TRI 50-70", action: "Ouvrir Attribution V1", objective: "Expliquer les gains et pertes avant V2", minInclusive: 50, maxExclusive: 70, tone: "subtle" },
  { label: "TRI 70-85", action: "Autoriser allocation intelligente", objective: "Allocation plus riche mais toujours gouvernee", minInclusive: 70, maxExclusive: 85, tone: "good" },
  { label: "TRI > 85", action: "Alpha V2 admissible", objective: "Seulement si les autres gates restent stables", minInclusive: 85, maxExclusive: Number.POSITIVE_INFINITY, tone: "good" },
] as const;
const DECISION_CONTINUITY_RULES = [
  { label: "CRITICAL", action: "Decision Gap Reduction Campaign", objective: "Journey Completion 0-5% · Alpha V2 interdit", minInclusive: Number.NEGATIVE_INFINITY, maxExclusive: 5, tone: "warn" },
  { label: "EXPLORATORY", action: "Decision Gap Reduction Campaign", objective: "Journey Completion 5-15% · faire baisser le first missing stage dominant", minInclusive: 5, maxExclusive: 15, tone: "warn" },
  { label: "EMERGING", action: "Evidence Conversion Engine", objective: "Journey Completion 15-30% · convertir INFERRED vers BACKFILLED", minInclusive: 15, maxExclusive: 30, tone: "subtle" },
  { label: "GOVERNABLE", action: "Economic Governance", objective: "Journey Completion 30-60% · hardening intelligence et friction economics", minInclusive: 30, maxExclusive: 60, tone: "subtle" },
  { label: "TRUSTED", action: "Alpha Attribution V1 admissible", objective: "Journey Completion 60-85% · preuve assez mature pour attribution", minInclusive: 60, maxExclusive: 85, tone: "good" },
  { label: "CERTIFIED", action: "Alpha V2 admissible", objective: "Journey Completion > 85% · gouvernance causale certifiee", minInclusive: 85, maxExclusive: Number.POSITIVE_INFINITY, tone: "good" },
] as const;

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

function formatDateTimeCompact(value: unknown): string {
  const raw = String(value || "").trim();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return raw || "-";
  }
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function formatCommitHash(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) {
    return "-";
  }
  return raw.length > 12 ? raw.slice(0, 12) : raw;
}

function formatUsd(value: number): string {
  return `${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)} USD`;
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toneClassForPct(value: number): string {
  if (value >= 95) {
    return "good";
  }
  if (value >= 70) {
    return "subtle";
  }
  return "warn";
}

function dedupeNonEmptyStrings(values: Array<unknown>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || normalized === "-" || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function formatTruthReliabilityStatus(value: unknown): string {
  switch (String(value || "").trim().toLowerCase()) {
    case "certified":
      return "CERTIFIED";
    case "exploitable":
      return "EXPLOITABLE";
    case "partial":
      return "PARTIAL";
    default:
      return "UNUSABLE";
  }
}

function traceStatusClass(value: unknown): string {
  switch (String(value || "").trim().toLowerCase()) {
    case "completed":
      return "good";
    case "pending":
      return "subtle";
    case "blocked":
      return "warn";
    default:
      return "subtle";
  }
}

function resolveTriGovernanceRule(scorePct: number): typeof TRI_GOVERNANCE_RULES[number] {
  return TRI_GOVERNANCE_RULES.find((rule) => scorePct >= rule.minInclusive && scorePct < rule.maxExclusive) || TRI_GOVERNANCE_RULES[0];
}

function resolveDecisionContinuityRule(scorePct: number): typeof DECISION_CONTINUITY_RULES[number] {
  return DECISION_CONTINUITY_RULES.find((rule) => scorePct >= rule.minInclusive && scorePct < rule.maxExclusive) || DECISION_CONTINUITY_RULES[0];
}

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonMap
    : {};
}

function asRecordArray(value: unknown): JsonMap[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as JsonMap[]
    : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function formatApiErrorDetail(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  const detail = asRecord(value);
  const direct = String(detail.detail || detail.reason || detail.status || "").trim();
  const hardening = asRecord(detail.hardening);
  const hardeningReasons = Array.isArray(hardening.reasons)
    ? hardening.reasons.map((item) => String(item)).filter(Boolean).join(", ")
    : "";
  if (direct && hardeningReasons) {
    return `${direct}: ${hardeningReasons}`;
  }
  if (direct) {
    return direct;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== "{}" ? serialized.slice(0, 280) : fallback;
  } catch (_error) {
    return fallback;
  }
}

function resolveFtmoAutoSymbol(generatedAt: string): string {
  const parsedMs = Date.parse(generatedAt || "");
  const now = Number.isFinite(parsedMs) ? new Date(parsedMs) : new Date();
  const weekday = now.getUTCDay();
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const minutes = hour * 60 + minute;
  const mondayOpenMinutes = 65;
  const fridayCloseMinutes = 23 * 60 + 50;
  const fxClosed = weekday === 0
    || weekday === 6
    || (weekday === 1 && minutes < mondayOpenMinutes)
    || (weekday === 5 && minutes >= fridayCloseMinutes);
  return fxClosed ? "BTCUSD" : "EURUSD";
}

function isSystemMode(value: unknown): value is SystemMode {
  return value === "suggest" || value === "guarded_auto" || value === "managed_live";
}

function readSystemModeOverride(): SystemMode | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(SYSTEM_MODE_OVERRIDE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as JsonMap;
    const mode = parsed.mode;
    const updatedAtMs = Number(parsed.updatedAtMs || 0);
    if (!isSystemMode(mode) || !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > SYSTEM_MODE_OVERRIDE_TTL_MS) {
      window.sessionStorage.removeItem(SYSTEM_MODE_OVERRIDE_STORAGE_KEY);
      return null;
    }
    return mode;
  } catch (_error) {
    window.sessionStorage.removeItem(SYSTEM_MODE_OVERRIDE_STORAGE_KEY);
    return null;
  }
}

function persistSystemModeOverride(mode: SystemMode): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(SYSTEM_MODE_OVERRIDE_STORAGE_KEY, JSON.stringify({ mode, updatedAtMs: Date.now() }));
}

function unwrapRows(payload: JsonMap | null): JsonMap[] {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload as JsonMap[];
  }
  const rows = payload.rows || payload.items || payload.data || payload.results || payload.payload;
  if (Array.isArray(rows)) {
    return rows as JsonMap[];
  }
  return [];
}

function valueTimeMs(row: JsonMap): number {
  const raw = row.ts_fill_final || row.filled_at || row.created_at || row.executed_at || row.labeled_at || row.timestamp || row.ts;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : 0;
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

export default function LiveOpsPageClient({ initialLiveOpsPayload = null }: LiveOpsPageClientProps) {
  const searchParams = useSearchParams();
  const auditFilter = String(searchParams?.get("audit_filter") || "").trim();
  const [liveOpsPayload, setLiveOpsPayload] = useState<JsonMap | null>(initialLiveOpsPayload);
  const [systemModePayload, setSystemModePayload] = useState<JsonMap | null>(null);
  const [killSwitchPayload, setKillSwitchPayload] = useState<JsonMap | null>(null);
  const [executionPnlAnalyzerPayload, setExecutionPnlAnalyzerPayload] = useState<JsonMap | null>(null);
  const [executionAiV6Payload, setExecutionAiV6Payload] = useState<JsonMap | null>(null);
  const [mt5PendingPayload, setMt5PendingPayload] = useState<JsonMap | null>(null);
  const [predictorAnalyticsPayload, setPredictorAnalyticsPayload] = useState<JsonMap | null>(null);
  const [predictorAnalyticsError, setPredictorAnalyticsError] = useState<string | null>(null);
  const [executionTelemetryPayload, setExecutionTelemetryPayload] = useState<JsonMap | null>(null);
  const [recentOutcomesPayload, setRecentOutcomesPayload] = useState<JsonMap | null>(null);
  const [recentGapPayload, setRecentGapPayload] = useState<JsonMap | null>(null);
  const [dailyPlanSprintStart, setDailyPlanSprintStart] = useState<string>(HYDRATION_SAFE_DATE_KEY);
  const [dailyPlanChecks, setDailyPlanChecks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!initialLiveOpsPayload);
  const [error, setError] = useState<string | null>(null);
  const [alphaSubmitBusy, setAlphaSubmitBusy] = useState(false);
  const [alphaApproveBusyId, setAlphaApproveBusyId] = useState<string | null>(null);
  const [alphaFeedback, setAlphaFeedback] = useState<string | null>(null);
  const [emergencyStopBusy, setEmergencyStopBusy] = useState(false);
  const [emergencyStopFeedback, setEmergencyStopFeedback] = useState<string | null>(null);
  const [systemModeBusy, setSystemModeBusy] = useState(false);
  const [systemModeFeedback, setSystemModeFeedback] = useState<string | null>(null);
  const [systemModeOverride, setSystemModeOverride] = useState<SystemMode | null>(() => readSystemModeOverride());
  const [selectedDecisionTraceId, setSelectedDecisionTraceId] = useState<string>("");
  const [decisionTraceQueryInput, setDecisionTraceQueryInput] = useState<string>("");
  const [decisionTracePayload, setDecisionTracePayload] = useState<JsonMap | null>(null);
  const [decisionTraceBusy, setDecisionTraceBusy] = useState(false);
  const [decisionTraceError, setDecisionTraceError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const loadSequenceRef = useRef(0);
  const decisionTraceLoadSequenceRef = useRef(0);

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
    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;
    setBusy(true);
    try {
      const fetchJsonWithTimeout = async (url: string, timeoutMs: number): Promise<FetchJsonResult> => {
        const controller = new AbortController();
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (!settled) {
            controller.abort();
          }
        }, timeoutMs);
        try {
          const response = await fetch(url, {
            cache: "no-store",
            signal: controller.signal,
            headers: { "X-TXT-Request-Source": "ui" },
          }).catch(() => null);
          if (!response) {
            return { response, payload: null };
          }
          const payload = await response.json().catch(() => null);
          return { response, payload: payload && typeof payload === "object" ? payload as JsonMap : null };
        } finally {
          settled = true;
          window.clearTimeout(timeout);
        }
      };

      const liveOpsParams = new URLSearchParams({ source: "ui" });
      if (auditFilter) {
        liveOpsParams.set("audit_filter", auditFilter);
      }
      const liveOpsUrl = `/api/system/live-ops?${liveOpsParams.toString()}`;
      const [
        liveOpsResponse,
        systemModeResponse,
        killSwitchResponse,
        pnlResponse,
        executionAiResponse,
        mt5PendingResponse,
        predictorAnalyticsResponse,
        telemetryResponse,
        outcomesResponse,
        gapResponse,
      ] = await Promise.all([
        fetchJsonWithTimeout(liveOpsUrl, LIVE_OPS_PRIMARY_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/system/mode", LIVE_OPS_MODE_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/system/kill-switch", LIVE_OPS_MODE_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/execution/pnl-analyzer?scope_type=strategy&scope_id=mt5-live&limit=50", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/execution/ai/v6/state", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/mt5/orders/live-pending", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/system/predictor-rejection-analytics?sinceDays=30", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/execution/telemetry/recent?limit=80", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/outcomes/recent?limit=80", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
        fetchJsonWithTimeout("/api/execution/reality-gap/recent?limit=80", LIVE_OPS_OPTIONAL_FETCH_TIMEOUT_MS),
      ]);
      if (loadSequenceRef.current !== loadSequence) {
        return;
      }
      if (!liveOpsResponse.response && !liveOpsPayload) {
        throw new Error("Live Ops indisponible");
      }
      if (liveOpsResponse.response && !liveOpsResponse.response.ok && !liveOpsPayload) {
        throw new Error(String(liveOpsResponse.payload?.detail || "Live Ops indisponible"));
      }
      if (liveOpsResponse.payload) {
        setLiveOpsPayload(liveOpsResponse.payload);
      }
      if (systemModeResponse.payload) {
        setSystemModePayload(systemModeResponse.payload);
      }
      if (killSwitchResponse.payload) {
        setKillSwitchPayload(killSwitchResponse.payload);
      }
      setError(null);
      setLoading(false);
      setExecutionPnlAnalyzerPayload(pnlResponse.payload);
      setExecutionAiV6Payload(executionAiResponse.payload);
      setMt5PendingPayload(mt5PendingResponse.payload);
      setPredictorAnalyticsPayload(predictorAnalyticsResponse.response?.ok ? predictorAnalyticsResponse.payload : null);
      setPredictorAnalyticsError(
        predictorAnalyticsResponse.response && !predictorAnalyticsResponse.response.ok
          ? formatApiErrorDetail(predictorAnalyticsResponse.payload, "Contrat predictor indisponible")
          : null,
      );
      setExecutionTelemetryPayload(telemetryResponse.payload);
      setRecentOutcomesPayload(outcomesResponse.payload);
      setRecentGapPayload(gapResponse.payload);
    } catch (err) {
      if (loadSequenceRef.current === loadSequence) {
        setError(err instanceof Error ? err.message : "Erreur inconnue");
      }
    } finally {
      if (loadSequenceRef.current === loadSequence) {
        setBusy(false);
        setLoading(false);
      }
    }
  }

  async function loadDecisionTrace(decisionId: string): Promise<void> {
    const cleanDecisionId = decisionId.trim();
    if (!cleanDecisionId) {
      setDecisionTracePayload(null);
      setDecisionTraceError(null);
      return;
    }
    const loadSequence = decisionTraceLoadSequenceRef.current + 1;
    decisionTraceLoadSequenceRef.current = loadSequence;
    setDecisionTraceBusy(true);
    setDecisionTraceError(null);
    try {
      const response = await fetch(`/api/system/decision-trace?decisionId=${encodeURIComponent(cleanDecisionId)}&mode=lite`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      const normalizedPayload = payload && typeof payload === "object" ? payload as JsonMap : null;
      if (decisionTraceLoadSequenceRef.current !== loadSequence) {
        return;
      }
      setDecisionTracePayload(normalizedPayload);
      if (!response.ok) {
        setDecisionTraceError(formatApiErrorDetail(payload, "Trace decision indisponible"));
        return;
      }
      setDecisionTraceError(null);
    } catch (err) {
      if (decisionTraceLoadSequenceRef.current === loadSequence) {
        setDecisionTracePayload(null);
        setDecisionTraceError(err instanceof Error ? err.message : "Erreur inconnue");
      }
    } finally {
      if (decisionTraceLoadSequenceRef.current === loadSequence) {
        setDecisionTraceBusy(false);
      }
    }
  }

  async function submitAlphaReactivationRequest(): Promise<void> {
    const alphaSymbol = resolveFtmoAutoSymbol(String(asRecord(liveOpsPayload).generated_at || ""));
    setAlphaSubmitBusy(true);
    setAlphaFeedback(null);
    try {
      const response = await fetch("/api/mt5/orders/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: "541283177",
          symbol: alphaSymbol,
          side: "buy",
          lots: 0.01,
          estimated_notional_usd: 5,
          max_spread_bps: 10,
          confidence: 0.8,
          preferred_venue: "mt5",
          rationale: "TXT alpha reactivation console: produce recent ACK/FILL proof loop",
          metadata: {
            source: "live-ops-alpha-reactivation-console",
            purpose: "proof_reactivation",
            auto_symbol_resolution: {
              requested: "AUTO",
              resolved: alphaSymbol,
              rule: "ftmo_week_window_else_btcusd",
            },
            requires_second_operator: true,
            operator_visible_flow: "TXT proposes -> operator approves -> TXT executes -> TXT measures",
          },
          order_intent: {
            source: "live-ops-alpha-reactivation-console",
            mode: "proof_reactivation",
            preset: "mt5_micro_fill",
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(formatApiErrorDetail(payload && typeof payload === "object" ? (payload as JsonMap).detail || payload : payload, "Demande live refusee"));
      }
      const status = String(payload && typeof payload === "object" ? (payload as JsonMap).status || "submitted" : "submitted");
      const approvalId = String(payload && typeof payload === "object" ? (payload as JsonMap).approval_id || "" : "");
      setAlphaFeedback(approvalId ? `Demande creee: ${status} · approval ${approvalId}` : `Demande envoyee: ${status}`);
      void appendLiveOpsJournalEntry("alpha-reactivation-requested", "Demande MT5 micro-fill creee depuis Live Ops", {
        source: "live-ops-alpha-reactivation-console",
        status,
        approval_id: approvalId || null,
      });
      await loadData();
    } catch (err) {
      setAlphaFeedback(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setAlphaSubmitBusy(false);
    }
  }

  async function approveAlphaReactivationRequest(approvalId: string): Promise<void> {
    const cleanApprovalId = approvalId.trim();
    if (!cleanApprovalId) {
      return;
    }
    setAlphaApproveBusyId(cleanApprovalId);
    setAlphaFeedback(null);
    try {
      const response = await fetch(`/api/mt5/orders/live-approve/${encodeURIComponent(cleanApprovalId)}`, {
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Approbation refusee" : "Approbation refusee"));
      }
      const status = String(payload && typeof payload === "object" ? (payload as JsonMap).status || "approved" : "approved");
      setAlphaFeedback(`Approbation envoyee: ${status}`);
      void appendLiveOpsJournalEntry("alpha-reactivation-approved", `Approval ${cleanApprovalId} envoyee depuis Live Ops`, {
        source: "live-ops-alpha-reactivation-console",
        approval_id: cleanApprovalId,
        status,
      });
      await loadData();
    } catch (err) {
      setAlphaFeedback(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setAlphaApproveBusyId(null);
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

  async function changeSystemMode(mode: SystemMode): Promise<void> {
    const previousMode = effectiveBackendMode;
    setSystemModeBusy(true);
    setSystemModeFeedback(null);
    try {
      const response = await fetch("/api/system/mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          previous_mode: previousMode,
          source: "live-ops-page",
          reason: mode === "managed_live" ? "desk_live_cutover" : "desk_posture_change",
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(String(payload && typeof payload === "object" ? (payload as JsonMap).detail || "Changement de mode refuse" : "Changement de mode refuse"));
      }
      const nextMode = String(payload && typeof payload === "object" ? (payload as JsonMap).system_mode || mode : mode) as SystemMode;
      const confirmedPreviousMode = String(payload && typeof payload === "object" ? (payload as JsonMap).previous_mode || previousMode : previousMode);
      persistSystemModeOverride(nextMode);
      setSystemModeOverride(nextMode);
      setSystemModeFeedback(
        String(payload && typeof payload === "object" ? (payload as JsonMap).status : "updated") === "unchanged"
          ? `Mode systeme deja actif: ${nextMode}`
          : `Mode systeme: ${confirmedPreviousMode} -> ${nextMode}`,
      );
      void appendLiveOpsJournalEntry("system-mode-changed", `Mode ${confirmedPreviousMode} -> ${nextMode}`, {
        source: "live-ops-page",
        previous_mode: confirmedPreviousMode,
        next_mode: nextMode,
      });
      await loadData();
    } catch (err) {
      setSystemModeFeedback(err instanceof Error ? err.message : "Erreur inconnue");
    } finally {
      setSystemModeBusy(false);
    }
  }

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    let mounted = true;
    let timer: number | null = null;
    const refresh = async () => {
      if (!mounted) {
        return;
      }
      await loadData();
    };
    const scheduleNextRefresh = () => {
      if (!mounted) {
        return;
      }
      if (timer) {
        window.clearTimeout(timer);
      }
      const intervalMs = document.visibilityState === "visible"
        ? LIVE_OPS_VISIBLE_REFRESH_MS
        : LIVE_OPS_HIDDEN_REFRESH_MS;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          void refresh();
        }
        scheduleNextRefresh();
      }, intervalMs);
    };
    const initialRefreshDelayMs = initialLiveOpsPayload ? INITIAL_LIVE_OPS_CONVERGENCE_DELAY_MS : 0;
    const initialRefreshTimer = window.setTimeout(() => {
      void refresh();
    }, initialRefreshDelayMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
      scheduleNextRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleNextRefresh();
    return () => {
      mounted = false;
      window.clearTimeout(initialRefreshTimer);
      if (timer) {
        window.clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [auditFilter, initialLiveOpsPayload]);

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
  const liveOpsDiagnostics = asRecord(snapshot.live_ops_diagnostics);
  const measurementWindow7d = asRecord(liveOpsDiagnostics.measurement_window_7d);
  const measurementWindow30d = asRecord(liveOpsDiagnostics.measurement_window_30d);
  const truthReliability = asRecord(liveOpsDiagnostics.truth_reliability_index);
  const truthReliabilityScorePct = toNumber(liveOpsDiagnostics.truth_reliability_index_pct || truthReliability.score_pct, 0);
  const truthReliabilityRawScorePct = toNumber(truthReliability.raw_score_pct, truthReliabilityScorePct);
  const truthReliabilityStatus = formatTruthReliabilityStatus(truthReliability.status);
  const truthReliabilityCapPct = Number.isFinite(Number(truthReliability.cap_pct)) ? Number(truthReliability.cap_pct) : null;
  const truthReliabilityCapReasons = Array.isArray(truthReliability.cap_reasons) ? truthReliability.cap_reasons.map((item) => String(item)).filter(Boolean) : [];
  const truthReliabilityComponents = asRecord(truthReliability.components);
  const truthReliabilityFreshnessPct = toNumber(truthReliabilityComponents.snapshot_freshness_pct, 0);
  const truthReliability7dWindow = asRecord(measurementWindow7d.truth_reliability);
  const truthReliability30dWindow = asRecord(measurementWindow30d.truth_reliability);
  const truthReliability7dLatestPct = toNumber(truthReliability7dWindow.latest_score_pct, truthReliabilityScorePct);
  const truthReliability7dGrowthPct = toNumber(truthReliability7dWindow.reliability_growth_pct, 0);
  const truthReliability30dLatestPct = toNumber(truthReliability30dWindow.latest_score_pct, truthReliabilityScorePct);
  const truthReliability30dGrowthPct = toNumber(truthReliability30dWindow.reliability_growth_pct, 0);
  const truthReliability7dContinuityAvgPct = toNumber(asRecord(truthReliability7dWindow.continuity_pct).avg, 0);
  const truthReliability30dContinuityAvgPct = toNumber(asRecord(truthReliability30dWindow.continuity_pct).avg, 0);
  const truthReliability7dEvidenceAvgPct = toNumber(asRecord(truthReliability7dWindow.evidence_pct).avg, 0);
  const truthReliability30dEvidenceAvgPct = toNumber(asRecord(truthReliability30dWindow.evidence_pct).avg, 0);
  const truthReliability30dStatusCounts = asRecord(truthReliability30dWindow.status_counts);
  const truthReliabilityGovernanceRule = resolveTriGovernanceRule(truthReliabilityScorePct);
  const watchdog = asRecord(snapshot.watchdog_state);
  const governance = asRecord(snapshot.governance);
  const recovery = asRecord(snapshot.recovery);
  const memoryGap = asRecord(snapshot.memory_gap);
  const canonicalSpine = asRecord(snapshot.canonical_spine);
  const sourceTreeProvenance = asRecord(snapshot.source_tree_provenance);
  const sourceTreeCertification = asRecord(snapshot.source_tree_certification);
  const sourceTreeProvenanceNormalized = normalizeSourceTreeProvenance(sourceTreeProvenance);
  const sourceTreeCommitDelta = getSourceTreeCommitDeltaLines(sourceTreeProvenanceNormalized);
  const sourceTreeProvenance7d = asRecord(measurementWindow7d.source_tree_provenance);
  const sourceTreeProvenance30d = asRecord(measurementWindow30d.source_tree_provenance);
  const sourceTreeCommitAlignmentRatePct = toNumber(sourceTreeProvenance.commit_alignment_rate, 0);
  const spineMatchRatePct = toNumber(canonicalSpine.spine_match_rate_pct, 0);
  const spineAllocationLinkRatePct = toNumber(canonicalSpine.allocation_link_rate_pct, 0);
  const spineApprovalLinkRatePct = toNumber(canonicalSpine.approval_link_rate_pct, 0);
  const spineApprovalExecutionLinkRatePct = toNumber(canonicalSpine.approval_execution_link_rate_pct, 0);
  const spineHardeningLinkRatePct = toNumber(canonicalSpine.hardening_link_rate_pct, 0);
  const spineExecutionLinkRatePct = toNumber(canonicalSpine.execution_link_rate_pct, 0);
  const spineOutcomeLinkRatePct = toNumber(canonicalSpine.outcome_link_rate_pct, 0);
  const spineOpportunityLinkRatePct = toNumber(canonicalSpine.opportunity_link_rate_pct, 0);
  const spineOpportunityLinkRateRawPct = toNumber(canonicalSpine.opportunity_link_rate_raw_pct, 0);
  const spineOpportunityLinkRatePostProducerPct = toNumber(canonicalSpine.opportunity_link_rate_post_producer_pct, 0);
  const spineExecutionDerivationRatePct = toNumber(canonicalSpine.execution_derivation_rate_pct, 0);
  const spineMatchingRatePct = toNumber(canonicalSpine.opportunity_matching_rate_pct, 0);
  const spineFollowupMatchingRatePct = toNumber(canonicalSpine.followup_expected_matching_rate_pct, 0);
  const spineAlphaCoveragePct = toNumber(canonicalSpine.alpha_attribution_coverage_pct, 0);
  const spineOperationalRefusalByCode = Array.isArray(canonicalSpine.operational_refusal_by_code)
    ? (canonicalSpine.operational_refusal_by_code as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const spineOperationalRefusalByCodePostProducer = Array.isArray(canonicalSpine.operational_refusal_by_code_post_producer)
    ? (canonicalSpine.operational_refusal_by_code_post_producer as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const spinePendingByGate = Array.isArray(canonicalSpine.pending_by_gate)
    ? (canonicalSpine.pending_by_gate as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const tradeLifecycleHealth = asRecord(snapshot.trade_lifecycle_health);
  const lifecycleObservedTotal = toNumber(tradeLifecycleHealth.lifecycle_total, 0);
  const decisionJourneyCompletion = asRecord(tradeLifecycleHealth.decision_journey_completion);
  const decisionGapReduction = asRecord(tradeLifecycleHealth.decision_gap_reduction);
  const decisionGapResolution = asRecord(tradeLifecycleHealth.decision_gap_resolution);
  const terminalDecisionStateDiagnostic = asRecord(tradeLifecycleHealth.terminal_decision_state_diagnostic);
  const terminalClosedStates = asRecord(terminalDecisionStateDiagnostic.terminal_closed);
  const terminalActiveDebt = asRecord(terminalDecisionStateDiagnostic.active_debt);
  const terminalReviewRequired = asRecord(terminalDecisionStateDiagnostic.review_required);
  const terminalReviewRequiredItems = asRecordArray(terminalReviewRequired.items).slice(0, 6);
  const executionGapDiagnostic = asRecord(tradeLifecycleHealth.execution_gap_diagnostic);
  const executionGapBlockedFamilyBreakdown = asRecordArray(executionGapDiagnostic.blocked_family_breakdown);
  const decisionGapReduction7d = asRecord(measurementWindow7d.decision_gap_reduction);
  const decisionGapReduction30d = asRecord(measurementWindow30d.decision_gap_reduction);
  const decisionGapResolution7d = asRecord(measurementWindow7d.decision_gap_resolution);
  const decisionGapResolution30d = asRecord(measurementWindow30d.decision_gap_resolution);
  const createdDecisionTotal = toNumber(decisionJourneyCompletion.created_decision_total, 0);
  const completeDecisionTotal = toNumber(decisionJourneyCompletion.complete_decision_total, 0);
  const incompleteDecisionTotal = toNumber(decisionJourneyCompletion.incomplete_decision_total, Math.max(0, createdDecisionTotal - completeDecisionTotal));
  const journeyCompletionRatePct = toNumber(decisionJourneyCompletion.completion_rate_pct, toNumber(tradeLifecycleHealth.decision_continuity_score_pct, 0));
  const decisionGapReductionByStage = Array.isArray(decisionGapReduction.by_stage)
    ? (decisionGapReduction.by_stage as Array<Record<string, unknown>>)
    : [];
  const decisionGapReduction7dByStage = Array.isArray(decisionGapReduction7d.by_stage)
    ? (decisionGapReduction7d.by_stage as Array<Record<string, unknown>>)
    : [];
  const decisionGapReduction30dByStage = Array.isArray(decisionGapReduction30d.by_stage)
    ? (decisionGapReduction30d.by_stage as Array<Record<string, unknown>>)
    : [];
  const decisionGapReductionDominantStageRaw = decisionGapReductionByStage.reduce<Record<string, unknown> | null>((best, stage) => {
    if (!best) {
      return stage;
    }
    return toNumber(stage.blocked_decision_total, 0) > toNumber(best.blocked_decision_total, 0) ? stage : best;
  }, null);
  const decisionGapReductionDominantStage = decisionGapReductionDominantStageRaw && toNumber(decisionGapReductionDominantStageRaw.blocked_decision_total, 0) > 0
    ? decisionGapReductionDominantStageRaw
    : null;
  const decisionGapReduction7dDominantStageKey = String(decisionGapReduction7d.dominant_stage_key_latest || "").trim();
  const decisionGapReduction30dDominantStageKey = String(decisionGapReduction30d.dominant_stage_key_latest || "").trim();
  const decisionGapReduction7dDominantStage = decisionGapReduction7dByStage.find((stage) => String(stage.stage_key || "").trim() === decisionGapReduction7dDominantStageKey) || null;
  const decisionGapReduction30dDominantStage = decisionGapReduction30dByStage.find((stage) => String(stage.stage_key || "").trim() === decisionGapReduction30dDominantStageKey) || null;
  const gapResolutionRatePct = toNumber(decisionGapResolution.gap_resolution_rate_pct, journeyCompletionRatePct);
  const terminalPublishBlocked = Boolean(terminalDecisionStateDiagnostic.publish_blocked);
  const executionGapBlockedDecisionTotal = toNumber(executionGapDiagnostic.blocked_decision_total, 0);
  const lifecyclePublishBlocked = terminalPublishBlocked || executionGapBlockedDecisionTotal > 0;
  const lifecyclePublishBlockReasons = [
    ...asStringArray(terminalDecisionStateDiagnostic.publish_block_reasons),
    ...executionGapBlockedFamilyBreakdown.flatMap((entry) => {
      const familyKey = String(entry.family_key || "").trim();
      const total = toNumber(entry.decision_total, 0);
      return familyKey && total > 0 ? [`execution_gap:${familyKey}:${total}`] : [];
    }),
  ];
  const terminalClosedTotal = [
    toNumber(terminalClosedStates.cancelled, 0),
    toNumber(terminalClosedStates.stale_cancelled, 0),
    toNumber(terminalClosedStates.rejected, 0),
    toNumber(terminalClosedStates.hardening_rejected, 0),
    toNumber(terminalClosedStates.expired, 0),
  ].reduce((sum, value) => sum + value, 0);
  const meanTimeToContinuityHours = Number.isFinite(Number(decisionGapResolution.mean_time_to_continuity_hours))
    ? toNumber(decisionGapResolution.mean_time_to_continuity_hours, 0)
    : null;
  const dominantOpenGapLabel = String(decisionGapResolution.dominant_open_gap_label || decisionGapReductionDominantStage?.gap_label || "none").trim() || "none";
  const dominantOpenGapTotal = toNumber(decisionGapResolution.dominant_open_gap_total, 0);
  const dominantOpenGapSharePct = toNumber(decisionGapResolution.dominant_open_gap_share_pct, 0);
  const gapResolutionRate7dPct = toNumber(asRecord(decisionGapResolution7d.gap_resolution_rate_pct).avg, 0);
  const gapResolutionRate30dPct = toNumber(asRecord(decisionGapResolution30d.gap_resolution_rate_pct).avg, 0);
  const meanTimeToContinuity7dHours = Number.isFinite(Number(asRecord(decisionGapResolution7d.mean_time_to_continuity_hours).avg))
    ? toNumber(asRecord(decisionGapResolution7d.mean_time_to_continuity_hours).avg, 0)
    : null;
  const meanTimeToContinuity30dHours = Number.isFinite(Number(asRecord(decisionGapResolution30d.mean_time_to_continuity_hours).avg))
    ? toNumber(asRecord(decisionGapResolution30d.mean_time_to_continuity_hours).avg, 0)
    : null;
  const backlogAgeBuckets = Array.isArray(decisionGapResolution.backlog_age_buckets)
    ? (decisionGapResolution.backlog_age_buckets as Array<Record<string, unknown>>)
    : [];
  const backlogAgeBuckets7d = Array.isArray(decisionGapResolution7d.backlog_age_buckets)
    ? (decisionGapResolution7d.backlog_age_buckets as Array<Record<string, unknown>>)
    : [];
  const backlogAgeBuckets30d = Array.isArray(decisionGapResolution30d.backlog_age_buckets)
    ? (decisionGapResolution30d.backlog_age_buckets as Array<Record<string, unknown>>)
    : [];
  const oldestOpenGap = asRecord(decisionGapResolution.oldest_open_gap);
  const oldestOpenGap7d = asRecord(decisionGapResolution7d.oldest_open_gap);
  const oldestOpenGap30d = asRecord(decisionGapResolution30d.oldest_open_gap);
  const dominantGapCardinality = asRecord(decisionGapResolution.dominant_gap_cardinality);
  const dominantGapCardinality7d = asRecord(decisionGapResolution7d.dominant_gap_cardinality);
  const dominantGapCardinality30d = asRecord(decisionGapResolution30d.dominant_gap_cardinality);
  const dominantGapRootCauses = Array.isArray(dominantGapCardinality.by_root_cause)
    ? (dominantGapCardinality.by_root_cause as Array<Record<string, unknown>>)
    : [];
  const dominantGapRootCauses7d = Array.isArray(dominantGapCardinality7d.by_root_cause)
    ? (dominantGapCardinality7d.by_root_cause as Array<Record<string, unknown>>)
    : [];
  const dominantGapRootCauses30d = Array.isArray(dominantGapCardinality30d.by_root_cause)
    ? (dominantGapCardinality30d.by_root_cause as Array<Record<string, unknown>>)
    : [];
  const gapLedgerRows = Array.isArray(decisionGapResolution.gap_ledger)
    ? (decisionGapResolution.gap_ledger as Array<Record<string, unknown>>)
    : [];
  const dominantGapTopDecisions = Array.isArray(decisionGapResolution.dominant_gap_top_decisions)
    ? (decisionGapResolution.dominant_gap_top_decisions as Array<Record<string, unknown>>)
    : [];
  const recentlyResolvedGaps = Array.isArray(decisionGapResolution.recently_resolved_gaps)
    ? (decisionGapResolution.recently_resolved_gaps as Array<Record<string, unknown>>)
    : [];
  const openGapLedgerRows = gapLedgerRows.filter((entry) => String(entry.status || "open") === "open").slice(0, 10);
  const resolvedGapLedgerRows = recentlyResolvedGaps.slice(0, 5);
  const allocationWriterRootCauseCode = "allocation_writer_gap_downstream_present";
  const currentAllocationWriterCause = dominantGapRootCauses.find((cause) => String(cause.root_cause_code || "").trim() === allocationWriterRootCauseCode) || null;
  const allocationWriterCause7d = dominantGapRootCauses7d.find((cause) => String(cause.root_cause_code || "").trim() === allocationWriterRootCauseCode) || null;
  const allocationWriterCause30d = dominantGapRootCauses30d.find((cause) => String(cause.root_cause_code || "").trim() === allocationWriterRootCauseCode) || null;
  const allocationWriterClosure = asRecord(tradeLifecycleHealth.allocation_writer_closure);
  const allocationWriterStateMachine = asRecord(allocationWriterClosure.state_machine);
  const allocationWriterCoverage = asRecord(allocationWriterClosure.writer_coverage);
  const allocationWriterIdentityPropagation = asRecord(allocationWriterClosure.identity_propagation);
  const allocationWriterPropagation = asRecord(allocationWriterClosure.writer_propagation);
  const allocationWriterLatency = asRecord(allocationWriterClosure.writer_latency);
  const allocationWriterFailureTaxonomy = asRecord(allocationWriterClosure.writer_failure_taxonomy);
  const allocationWriterClosureEvidence = asRecord(allocationWriterClosure.closure_evidence);
  const allocationWriterNativeErrors = Array.isArray(allocationWriterClosure.writer_native_errors)
    ? (allocationWriterClosure.writer_native_errors as Array<Record<string, unknown>>)
    : [];
  const allocationWriterProvenance = Array.isArray(allocationWriterClosure.writer_provenance)
    ? (allocationWriterClosure.writer_provenance as Array<Record<string, unknown>>)
    : [];
  const allocationWriterFailureCategories = Array.isArray(allocationWriterFailureTaxonomy.by_category)
    ? (allocationWriterFailureTaxonomy.by_category as Array<Record<string, unknown>>)
      .filter((entry) => toNumber(entry.total, 0) > 0)
      .sort((left, right) => toNumber(right.total, 0) - toNumber(left.total, 0))
    : [];
  const allocationWriterAuditActive = Boolean(
    Object.keys(allocationWriterClosure).length > 0
    || Object.keys(allocationWriterCoverage).length > 0
    ||
    currentAllocationWriterCause
    || allocationWriterCause7d
    || allocationWriterCause30d
    || String(dominantGapCardinality7d.dominant_root_cause_code_latest || "").trim() === allocationWriterRootCauseCode
    || String(dominantGapCardinality30d.dominant_root_cause_code_latest || "").trim() === allocationWriterRootCauseCode,
  );
  const lifecycleCoverageScorePct = toNumber(tradeLifecycleHealth.link_coverage_score_pct, 0);
  const decisionContinuityScorePct = toNumber(tradeLifecycleHealth.decision_continuity_score_pct, 0);
  const decisionEvidenceQuality = asRecord(tradeLifecycleHealth.decision_evidence_quality);
  const decisionEvidenceQualityPct = toNumber(decisionEvidenceQuality.score_pct, 0);
  const evidencePipeline = [
    { key: "missing", label: "MISSING", value: toNumber(decisionEvidenceQuality.missing, 0), tone: "warn", next: "Convertir vers INFERRED" },
    { key: "inferred", label: "INFERRED", value: toNumber(decisionEvidenceQuality.inferred, 0), tone: "warn", next: "Convertir vers BACKFILLED" },
    { key: "backfilled", label: "BACKFILLED", value: toNumber(decisionEvidenceQuality.backfilled, 0), tone: "subtle", next: "Convertir vers NATIVE" },
    { key: "native", label: "NATIVE", value: toNumber(decisionEvidenceQuality.native, 0), tone: "good", next: "Preuve directement exploitable" },
  ];
  const evidenceTotal = evidencePipeline.reduce((sum, step) => sum + step.value, 0);
  const evidenceNativePct = evidenceTotal > 0 ? (toNumber(decisionEvidenceQuality.native, 0) / evidenceTotal) * 100 : 0;
  const dominantRootCauseCurrent = currentAllocationWriterCause || dominantGapRootCauses[0] || null;
  const dominantRootCause7d = allocationWriterCause7d || dominantGapRootCauses7d[0] || null;
  const dominantRootCause30d = allocationWriterCause30d || dominantGapRootCauses30d[0] || null;
  const dominantRootCauseLabel = String(
    dominantRootCauseCurrent?.label
    || dominantGapTopDecisions[0]?.root_cause
    || dominantGapCardinality7d.dominant_root_cause_label_latest
    || dominantGapCardinality30d.dominant_root_cause_label_latest
    || "none",
  ).trim() || "none";
  const rootCauseConcentrationPct = toNumber(dominantRootCauseCurrent?.share_pct, 0);
  const rootCauseConcentration7dPct = toNumber(asRecord(dominantRootCause7d?.share_pct).avg, 0);
  const rootCauseConcentration30dPct = toNumber(asRecord(dominantRootCause30d?.share_pct).avg, 0);
  const rootCauseConcentrationTone = rootCauseConcentrationPct >= 80 ? "warn" : rootCauseConcentrationPct >= 40 ? "subtle" : "good";
  const allocationClosureRatePct = toNumber(allocationWriterStateMachine.allocation_closure_rate_pct, 0);
  const allocationClosureRateTone = toneClassForPct(allocationClosureRatePct);
  const rootCauseClosureRatePct = toNumber(allocationWriterClosureEvidence.root_cause_closure_rate_pct, 0);
  const rootCauseClosureRateTone = toneClassForPct(rootCauseClosureRatePct);
  const decisionEvidenceQualityByStage = Array.isArray(decisionEvidenceQuality.by_stage)
    ? (decisionEvidenceQuality.by_stage as Array<Record<string, unknown>>)
    : [];
  const decisionContinuityGovernanceRule = resolveDecisionContinuityRule(journeyCompletionRatePct);
  const lifecycleAllocationLinkRatePct = toNumber(tradeLifecycleHealth.allocation_link_rate_pct, 0);
  const lifecycleApprovalLinkRatePct = toNumber(tradeLifecycleHealth.approval_link_rate_pct, 0);
  const lifecycleHardeningLinkRatePct = toNumber(tradeLifecycleHealth.hardening_link_rate_pct, 0);
  const lifecycleExecutionLinkRatePct = toNumber(tradeLifecycleHealth.execution_link_rate_pct, 0);
  const lifecycleOutcomeLinkRatePct = toNumber(tradeLifecycleHealth.outcome_link_rate_pct, 0);
  const lifecycleAttributionLinkRatePct = toNumber(tradeLifecycleHealth.attribution_link_rate_pct, 0);
  const lifecycleOpportunityLinkRatePct = toNumber(tradeLifecycleHealth.opportunity_link_rate_pct, 0);
  const lifecycleCausalityConfidence = asRecord(tradeLifecycleHealth.causality_confidence);
  const decisionContinuityLinks = Array.isArray(tradeLifecycleHealth.decision_continuity_links)
    ? (tradeLifecycleHealth.decision_continuity_links as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  const lifecycleTopDecisionFriction = Array.isArray(tradeLifecycleHealth.top_decision_friction)
    ? (tradeLifecycleHealth.top_decision_friction as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const lifecycleTopFrictionByGate = Array.isArray(tradeLifecycleHealth.top_friction_by_gate)
    ? (tradeLifecycleHealth.top_friction_by_gate as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const decisionFriction = asRecord(tradeLifecycleHealth.decision_friction);
  const decisionFrictionBlockedTotal = toNumber(decisionFriction.blocked_total, 0);
  const decisionFrictionUniqueDecisionTotal = toNumber(decisionFriction.unique_decision_total, 0);
  const decisionFrictionRepeatedDecisionTotal = toNumber(decisionFriction.repeated_decision_total, 0);
  const decisionFrictionRepeatedBlockedTotal = toNumber(decisionFriction.repeated_blocked_total, 0);
  const decisionFrictionRepeatedBlockedSharePct = toNumber(decisionFriction.repeated_blocked_share_pct, 0);
  const decisionFrictionOpportunityCostBpsTotal = toNumber(decisionFriction.opportunity_cost_bps_total, 0);
  const decisionFrictionMissedAlphaBpsTotal = toNumber(decisionFriction.missed_alpha_bps_total, 0);
  const decisionFrictionCapitalImpactUsdTotal = toNumber(decisionFriction.capital_impact_usd_total, 0);
  const decisionFrictionCapitalImpactPerDecision = toNumber(decisionFriction.capital_impact_per_decision, 0);
  const decisionFrictionCapitalImpactCoveragePct = toNumber(decisionFriction.capital_impact_coverage_pct, 0);
  const decisionFrictionCapitalBasisAvailableRows = toNumber(decisionFriction.capital_basis_available_rows, 0);
  const decisionFrictionCapitalBasisMissingRows = toNumber(decisionFriction.capital_basis_missing_rows, 0);
  const decisionFrictionCapitalBasisRowTotal = decisionFrictionCapitalBasisAvailableRows + decisionFrictionCapitalBasisMissingRows;
  const decisionFrictionDominantGateName = String(decisionFriction.dominant_gate_name || "-");
  const decisionFrictionDominantGateBlockedTotal = toNumber(decisionFriction.dominant_gate_blocked_total, 0);
  const decisionFrictionDominantGateSharePct = toNumber(decisionFriction.dominant_gate_share_pct, 0);
  const decisionFrictionDominantCostGateName = String(decisionFriction.dominant_cost_gate_name || "-");
  const decisionFrictionDominantCostGateCapitalImpactUsd = toNumber(decisionFriction.dominant_cost_gate_capital_impact_usd, 0);
  const decisionFrictionDominantDecisionId = String(decisionFriction.dominant_decision_id || "-");
  const decisionFrictionDominantDecisionGateName = String(decisionFriction.dominant_decision_gate_name || "-");
  const decisionFrictionDominantDecisionBlockedTotal = toNumber(decisionFriction.dominant_decision_blocked_total, 0);
  const decisionFrictionDominantDecisionSharePct = toNumber(decisionFriction.dominant_decision_share_pct, 0);
  const decisionFrictionDominantCostDecisionId = String(decisionFriction.dominant_cost_decision_id || "-");
  const decisionFrictionDominantCostDecisionGateName = String(decisionFriction.dominant_cost_decision_gate_name || "-");
  const decisionFrictionDominantCostDecisionOpportunityCostBps = toNumber(decisionFriction.dominant_cost_decision_opportunity_cost_bps, 0);
  const decisionFrictionDominantCostDecisionMissedAlphaBps = toNumber(decisionFriction.dominant_cost_decision_missed_alpha_bps, 0);
  const decisionFrictionDominantCostDecisionCapitalImpactUsd = toNumber(decisionFriction.dominant_cost_decision_capital_impact_usd, 0);
  const decisionFrictionWatchlistGates = Array.isArray(decisionFriction.watchlist_gates)
    ? (decisionFriction.watchlist_gates as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const decisionFrictionTopDecisions = Array.isArray(decisionFriction.top_decisions)
    ? (decisionFriction.top_decisions as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const decisionFrictionTopGates = Array.isArray(decisionFriction.top_gates)
    ? (decisionFriction.top_gates as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const decisionFrictionTopCostDecisions = Array.isArray(decisionFriction.top_cost_decisions)
    ? (decisionFriction.top_cost_decisions as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const decisionFrictionTopCostGates = Array.isArray(decisionFriction.top_cost_gates)
    ? (decisionFriction.top_cost_gates as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const decisionTraceCandidateIds = dedupeNonEmptyStrings([
    decisionFrictionDominantDecisionId,
    decisionFrictionDominantCostDecisionId,
    ...lifecycleTopDecisionFriction.map((item) => String(item.decision_id || "")),
    ...decisionFrictionTopDecisions.map((item) => String(item.decision_id || "")),
    ...decisionFrictionTopCostDecisions.map((item) => String(item.decision_id || "")),
  ]).slice(0, 8);
  const hardeningAnalytics = asRecord(snapshot.hardening_analytics_30d);
  const hardeningApprovalStage2Total = toNumber(hardeningAnalytics.approval_stage_2_total, 0);
  const hardeningRefusedTotal = toNumber(hardeningAnalytics.hardening_refused_total, 0);
  const hardeningUniqueDecisionTotal = toNumber(hardeningAnalytics.unique_decision_total, 0);
  const hardeningTopRefusalCauses = Array.isArray(hardeningAnalytics.top_refusal_causes)
    ? (hardeningAnalytics.top_refusal_causes as Array<Record<string, unknown>>).slice(0, 10)
    : Array.isArray(hardeningAnalytics.rows)
      ? (hardeningAnalytics.rows as Array<Record<string, unknown>>).slice(0, 10)
      : [];
  const hardeningTopCostCauses = Array.isArray(hardeningAnalytics.top_cost_causes)
    ? (hardeningAnalytics.top_cost_causes as Array<Record<string, unknown>>).slice(0, 10)
    : [];
  const hardeningTopMissedAlphaCauses = Array.isArray(hardeningAnalytics.top_missed_alpha_causes)
    ? (hardeningAnalytics.top_missed_alpha_causes as Array<Record<string, unknown>>).slice(0, 10)
    : [];
  const runtimeTruth = asRecord(asRecord(snapshot.raw).runtime_truth);
  const runtimeTruthLayers = asRecord(runtimeTruth.layers);
  const decisionReality = asRecord(runtimeTruthLayers.decision_reality);
  const decisionRealityState = String(decisionReality.decision_reality_state || "UNKNOWN").toUpperCase();
  const decisionRealityNextGate = String(decisionReality.next_gate || "-");
  const decisionCoverageRaw = Number(decisionReality.decision_quote_coverage_pct);
  const decisionCoveragePct = Number.isFinite(decisionCoverageRaw) ? decisionCoverageRaw : null;
  const decisionCoveredRows = toNumber(decisionReality.decision_quote_covered_rows, 0);
  const decisionUncoveredRows = toNumber(decisionReality.decision_quote_uncovered_rows, 0);
  const decisionObservedIgnoredRows = toNumber(decisionReality.decision_quote_observed_ignored_rows, 0);
  const decisionObservedIgnoredRateRaw = Number(decisionReality.decision_quote_observed_ignored_rate_pct);
  const decisionObservedIgnoredRatePct = Number.isFinite(decisionObservedIgnoredRateRaw) ? decisionObservedIgnoredRateRaw : null;
  const decisionIgnoredGateThresholdRaw = Number(decisionReality.decision_quote_ignored_gate_threshold_pct);
  const decisionIgnoredGateThresholdPct = Number.isFinite(decisionIgnoredGateThresholdRaw) ? decisionIgnoredGateThresholdRaw : 5;
  const decisionIgnoredGateAlert = Boolean(decisionReality.decision_quote_ignored_gate_alert);
  const decisionCoverageTone = decisionCoveragePct === null
    ? "subtle"
    : decisionCoveragePct >= 100
      ? "good"
      : decisionCoveragePct >= 75
        ? "subtle"
        : "warn";
  const decisionTopUncoveredReasons = Array.isArray(decisionReality.decision_quote_top_uncovered_reasons)
    ? (decisionReality.decision_quote_top_uncovered_reasons as Array<Record<string, unknown>>)
      .slice(0, 4)
      .map((item) => ({
        reason: formatReasonLabel(String(item.reason || "")),
        count: toNumber(item.count, 0),
      }))
      .filter((item) => item.reason !== "n/a")
    : [];
  const decisionCoverageBreakdown = Array.isArray(decisionReality.decision_quote_coverage_breakdown)
    ? (decisionReality.decision_quote_coverage_breakdown as Array<Record<string, unknown>>)
      .slice(0, 8)
      .map((item) => ({
        label: String(item.label || "").trim() || formatReasonLabel(String(item.key || "")),
        count: toNumber(item.count, 0),
        sharePct: Number.isFinite(Number(item.share_pct)) ? Number(item.share_pct) : null,
      }))
      .filter((item) => item.label !== "n/a")
    : [];
  const decisionCoverageTrend = asRecord(decisionReality.decision_quote_coverage_breakdown_trend);
  const decisionCoverageTrend24h = asRecord(decisionCoverageTrend.last_24h);
  const decisionCoverageTrend7d = asRecord(decisionCoverageTrend.last_7d);
  const decisionCoverageTrendRows = [
    {
      label: "24h",
      sampleRows: toNumber(decisionCoverageTrend24h.sample_rows, 0),
      observedUsedPct: (() => {
        const breakdown = Array.isArray(decisionCoverageTrend24h.breakdown) ? decisionCoverageTrend24h.breakdown as Array<Record<string, unknown>> : [];
        const found = breakdown.find((item) => String(item.key || "") === "quote_observed_and_used");
        const pct = Number(found?.share_pct);
        return Number.isFinite(pct) ? pct : null;
      })(),
      observedIgnoredPct: (() => {
        const breakdown = Array.isArray(decisionCoverageTrend24h.breakdown) ? decisionCoverageTrend24h.breakdown as Array<Record<string, unknown>> : [];
        const found = breakdown.find((item) => String(item.key || "") === "quote_observed_but_ignored");
        const pct = Number(found?.share_pct);
        return Number.isFinite(pct) ? pct : null;
      })(),
    },
    {
      label: "7j",
      sampleRows: toNumber(decisionCoverageTrend7d.sample_rows, 0),
      observedUsedPct: (() => {
        const breakdown = Array.isArray(decisionCoverageTrend7d.breakdown) ? decisionCoverageTrend7d.breakdown as Array<Record<string, unknown>> : [];
        const found = breakdown.find((item) => String(item.key || "") === "quote_observed_and_used");
        const pct = Number(found?.share_pct);
        return Number.isFinite(pct) ? pct : null;
      })(),
      observedIgnoredPct: (() => {
        const breakdown = Array.isArray(decisionCoverageTrend7d.breakdown) ? decisionCoverageTrend7d.breakdown as Array<Record<string, unknown>> : [];
        const found = breakdown.find((item) => String(item.key || "") === "quote_observed_but_ignored");
        const pct = Number(found?.share_pct);
        return Number.isFinite(pct) ? pct : null;
      })(),
    },
  ];
  const decisionIgnoredDrilldown = Array.isArray(decisionReality.decision_quote_ignored_drilldown)
    ? (decisionReality.decision_quote_ignored_drilldown as Array<Record<string, unknown>>)
      .slice(0, 8)
      .map((item) => ({
        path: String(item.decision_path || "").trim() || "unknown_path",
        source: String(item.source || "").trim() || "unknown_source",
        reason: formatReasonLabel(String(item.decision_reason || "").trim() || "n/a"),
        count: toNumber(item.count, 0),
        sharePct: Number.isFinite(Number(item.share_pct)) ? Number(item.share_pct) : null,
        recentDecisionIds: Array.isArray(item.recent_decision_ids)
          ? (item.recent_decision_ids as Array<unknown>).map((value) => String(value || "").trim()).filter(Boolean).slice(0, 3)
          : [],
      }))
      .sort((a, b) => b.count - a.count)
      .filter((item) => item.count > 0)
    : [];
  const decisionIgnoredReasonBreakdown = Array.isArray(decisionReality.decision_quote_ignored_reason_breakdown)
    ? (decisionReality.decision_quote_ignored_reason_breakdown as Array<Record<string, unknown>>)
      .slice(0, 8)
      .map((item) => ({
        reason: formatReasonLabel(String(item.reason || "").trim() || "n/a"),
        count: toNumber(item.count, 0),
        sharePct: Number.isFinite(Number(item.share_pct)) ? Number(item.share_pct) : null,
      }))
      .filter((item) => item.count > 0)
    : [];
  const decisionPathIgnoredThresholdRaw = Number(decisionReality.decision_quote_ignored_path_threshold_pct);
  const decisionPathIgnoredThresholdPct = Number.isFinite(decisionPathIgnoredThresholdRaw) ? decisionPathIgnoredThresholdRaw : 10;
  const decisionPathIgnoredAlerts = Array.isArray(decisionReality.decision_quote_ignored_path_alerts)
    ? (decisionReality.decision_quote_ignored_path_alerts as Array<Record<string, unknown>>)
      .slice(0, 8)
      .map((item) => ({
        path: String(item.decision_path || "").trim() || "unknown_path",
        ignoredRatePct: Number.isFinite(Number(item.ignored_rate_pct)) ? Number(item.ignored_rate_pct) : null,
        ignoredRows: toNumber(item.ignored_rows, 0),
        totalRows: toNumber(item.total_rows, 0),
        alert: Boolean(item.alert),
      }))
      .sort((a, b) => {
        if (a.alert !== b.alert) {
          return a.alert ? -1 : 1;
        }
        return (b.ignoredRatePct || 0) - (a.ignoredRatePct || 0);
      })
      .filter((item) => item.totalRows > 0)
    : [];
  const decisionPathReasonIgnoredThresholdRaw = Number(decisionReality.decision_quote_ignored_path_reason_threshold_pct);
  const decisionPathReasonIgnoredThresholdPct = Number.isFinite(decisionPathReasonIgnoredThresholdRaw) ? decisionPathReasonIgnoredThresholdRaw : 10;
  const decisionPathReasonImpactThresholdRaw = Number(decisionReality.decision_quote_ignored_path_reason_impact_threshold_pct_points);
  const decisionPathReasonImpactThresholdPctPoints = Number.isFinite(decisionPathReasonImpactThresholdRaw) ? decisionPathReasonImpactThresholdRaw : 1;
  const decisionPathReasonIgnoredAlerts = Array.isArray(decisionReality.decision_quote_ignored_path_reason_alerts)
    ? (decisionReality.decision_quote_ignored_path_reason_alerts as Array<Record<string, unknown>>)
      .slice(0, 8)
      .map((item) => ({
        path: String(item.decision_path || "").trim() || "unknown_path",
        reason: formatReasonLabel(String(item.decision_reason || "").trim() || "n/a"),
        ignoredRatePct: Number.isFinite(Number(item.ignored_rate_pct)) ? Number(item.ignored_rate_pct) : null,
        volumeSharePct: Number.isFinite(Number(item.volume_share_pct)) ? Number(item.volume_share_pct) : null,
        impactPctPoints: Number.isFinite(Number(item.impact_pct_points)) ? Number(item.impact_pct_points) : null,
        ignoredRows: toNumber(item.ignored_rows, 0),
        totalRows: toNumber(item.total_rows, 0),
        ignoredRateAlert: Boolean(item.ignored_rate_alert),
        impactAlert: Boolean(item.impact_alert),
        alert: Boolean(item.alert),
      }))
      .sort((a, b) => {
        if (a.alert !== b.alert) {
          return a.alert ? -1 : 1;
        }
        return (b.impactPctPoints || 0) - (a.impactPctPoints || 0);
      })
      .filter((item) => item.totalRows > 0 && item.ignoredRows > 0)
    : [];
  const decisionTopRemediationCandidates = Array.isArray(decisionReality.decision_quote_top_remediation_candidates)
    ? (decisionReality.decision_quote_top_remediation_candidates as Array<Record<string, unknown>>)
      .slice(0, 3)
      .map((item) => ({
        path: String(item.decision_path || "").trim() || "unknown_path",
        reason: formatReasonLabel(String(item.decision_reason || "").trim() || "n/a"),
        ignoredRatePct: Number.isFinite(Number(item.ignored_rate_pct)) ? Number(item.ignored_rate_pct) : null,
        volumeSharePct: Number.isFinite(Number(item.volume_share_pct)) ? Number(item.volume_share_pct) : null,
        impactPctPoints: Number.isFinite(Number(item.impact_pct_points)) ? Number(item.impact_pct_points) : null,
        ignoredRows: toNumber(item.ignored_rows, 0),
        totalRows: toNumber(item.total_rows, 0),
        ignoredRateAlert: Boolean(item.ignored_rate_alert),
        impactAlert: Boolean(item.impact_alert),
        alert: Boolean(item.alert),
        suggestedAction: String(item.suggested_action || "").trim() || "Inspect routing condition.",
      }))
      .filter((item) => item.ignoredRows > 0)
    : [];
  const controlledCollection = asRecord(snapshot.controlled_collection);
  const collectionLabelProgress = asRecord(controlledCollection.label_progress);
  const collectionEdgeConfidence = asRecord(controlledCollection.edge_confidence);
  const collectionStatus = String(controlledCollection.status || "UNCONFIGURED").toUpperCase();
  const collectionNextAction = String(controlledCollection.next_action || "Attend la prochaine mise a jour Live Ops.");
  const collectionThesis = String(controlledCollection.thesis || "Collecter des labels avant de chercher a optimiser.");
  const collectionConstraints = Array.isArray(controlledCollection.constraints) ? controlledCollection.constraints.map((item) => String(item)) : [];
  const collectionForbidden = Array.isArray(controlledCollection.forbidden) ? controlledCollection.forbidden.map((item) => String(item)) : [];
  const collectionStopConditions = Array.isArray(controlledCollection.stop_conditions) ? controlledCollection.stop_conditions.map((item) => String(item)) : [];
  const collectionStage = String(collectionLabelProgress.stage || "BOOTSTRAP");
  const collectionTargetMin = toNumber(collectionLabelProgress.targetMin, 50);
  const collectionTargetMax = toNumber(collectionLabelProgress.targetMax, 100);
  const collectionClassifiedCount = toNumber(collectionLabelProgress.classifiedCount, 0);
  const collectionRecentClassifiedCount = toNumber(collectionLabelProgress.recentClassifiedCount, 0);
  const collectionToTargetMin = toNumber(collectionLabelProgress.toTargetMin, Math.max(0, collectionTargetMin - collectionClassifiedCount));
  const collectionProgressToMinPct = Math.max(0, Math.min(100, toNumber(collectionLabelProgress.progressToMinPct, 0)));
  const collectionProgressToMaxPct = Math.max(0, Math.min(100, toNumber(collectionLabelProgress.progressToMaxPct, 0)));
  const collectionLabelSummary = String(collectionLabelProgress.summary || "Pas encore assez de labels classes pour faire vivre l'edge map.");
  const collectionConfidenceSummary = String(collectionEdgeConfidence.summary || "Confiance edge en attente de labels frais.");
  const collectionTone = collectionStatus === "READY" ? "good" : collectionStatus === "LOCKED" || collectionStatus === "BLOCKED" ? "warn" : "subtle";
  const microLiveProgram = asRecord(snapshot.micro_live_program);
  const microLiveInfrastructure = asRecord(microLiveProgram.infrastructure);
  const microLiveTargets = asRecord(microLiveProgram.session_targets);
  const microLiveProgress = asRecord(microLiveProgram.progress);
  const microLiveStage = asRecord(microLiveProgram.stage);
  const microLiveHardeningProgram = asRecord(microLiveProgram.hardening);
  const microLiveEntryStatus = String(microLiveProgram.entry_status || "UNKNOWN").toUpperCase();
  const microLiveEntryTone = microLiveEntryStatus === "OPEN" ? "good" : microLiveEntryStatus === "REDUCE" ? "subtle" : "warn";
  const microLiveEntryReasons = Array.isArray(microLiveProgram.entry_reasons) ? microLiveProgram.entry_reasons.map((item) => String(item)).filter(Boolean) : [];
  const microLiveWarningReasons = Array.isArray(microLiveProgram.warning_reasons) ? microLiveProgram.warning_reasons.map((item) => String(item)).filter(Boolean) : [];
  const microLiveActiveCutSwitches = Array.isArray(microLiveProgram.active_cut_switches) ? microLiveProgram.active_cut_switches.map((item) => String(item)).filter(Boolean) : [];
  const microLiveCurrentStage = String(microLiveStage.current_stage || "n/a");
  const microLiveStageCapUsd = toNumber(microLiveStage.max_order_notional_usd, 0);
  const microLiveStageBuckets = Array.isArray(microLiveStage.buckets) ? microLiveStage.buckets : [];
  const microLiveTransitionHistory = Array.isArray(microLiveStage.transition_history)
    ? (microLiveStage.transition_history as Array<Record<string, unknown>>)
    : [];
  const microLiveCreatedTarget = toNumber(microLiveTargets.created_decisions_target, 100);
  const microLiveCompleteTarget = toNumber(microLiveTargets.complete_decisions_target, 50);
  const microLiveCreatedProgressPct = Math.max(0, Math.min(100, toNumber(microLiveProgress.created_progress_pct, 0)));
  const microLiveCompleteProgressPct = Math.max(0, Math.min(100, toNumber(microLiveProgress.complete_progress_pct, 0)));
  const microLiveEntrySummary = microLiveEntryStatus === "OPEN"
    ? `${microLiveCurrentStage} · cap ${formatUsd(microLiveStageCapUsd)}`
    : dedupeNonEmptyStrings([...microLiveEntryReasons, ...microLiveWarningReasons]).slice(0, 2).join(" · ") || "Gate micro-live degrade";
  const controlledLiveRampGateReport = asRecord(snapshot.controlled_live_ramp_gate);
  const controlledLiveRampGate = asRecord(controlledLiveRampGateReport.controlled_live_ramp_gate);
  const controlledLiveRampRuntimeTruthGate = asRecord(controlledLiveRampGateReport.runtime_truth_gate);
  const controlledLiveRampReplayGate = asRecord(controlledLiveRampGateReport.replay_certification_gate);
  const controlledLiveRampPublicHealth = asRecord(controlledLiveRampGateReport.gateway_public_health);
  const controlledLiveRampPublicProbe = asRecord(controlledLiveRampGateReport.public_probe);
  const controlledLiveRampAuthProbe = asRecord(controlledLiveRampGateReport.auth_probe);
  const controlledLiveRampSettlementTruth = asRecord(controlledLiveRampGateReport.settlement_truth);
  const controlledLiveRampSettlementContextDiff = asRecord(controlledLiveRampGateReport.settlement_source_context_diff);
  const controlledLiveRampOpsRunnerContext = asRecord(controlledLiveRampGateReport.ops_runner_context);
  const controlledLiveRampBusHealth = asRecord(controlledLiveRampGateReport.bus_health);
  const controlledLiveRampBusPublisher = asRecord(controlledLiveRampBusHealth.publisher);
  const controlledLiveRampBusLiveObservation = asRecord(controlledLiveRampBusHealth.live_observation);
  const controlledLiveRampBusConsumer = asRecord(controlledLiveRampBusHealth.consumer);
  const controlledLiveRampBusTransport = asRecord(controlledLiveRampBusHealth.transport);
  const controlledLiveRampLegacyWatchdog = asRecord(controlledLiveRampGateReport.legacy_watchdog_reconciliation);
  const controlledLiveRampRuntimeTruthMatrix = asRecord(controlledLiveRampGateReport.runtime_truth_matrix);
  const controlledLiveRampRuntimeTruthMatrixCoverage = asRecord(controlledLiveRampRuntimeTruthMatrix.coverage);
  const controlledLiveRampRuntimeSourceMap = asRecord(controlledLiveRampGateReport.runtime_source_degradation_map);
  const controlledLiveRampRuntimeSourceRows = asRecordArray(controlledLiveRampRuntimeSourceMap.sources).slice(0, 8);
  const controlledLiveRampCleanliness = asRecord(controlledLiveRampGateReport.new_cycle_cleanliness);
  const controlledLiveRampAllowed = Boolean(controlledLiveRampGate.allowed);
  const controlledLiveRampOpsVerdictAvailable = controlledLiveRampGate.ops_verdict_available !== false;
  const controlledLiveRampOpsUnavailableReasons = asStringArray(controlledLiveRampGate.ops_verdict_unavailable_reasons);
  const controlledLiveRampMissingRuntimeSources = asStringArray(controlledLiveRampGate.missing_runtime_truth_sources);
  const controlledLiveRampDegradedRuntimeSources = asStringArray(controlledLiveRampGate.degraded_runtime_truth_sources);
  const controlledLiveRampKillSwitch = asRecord(controlledLiveRampGate.kill_switch);
  const controlledLiveRampKillSwitchResetBlockers = asStringArray(controlledLiveRampKillSwitch.reset_blockers);
  const controlledLiveRampAuthMissingFields = asStringArray(controlledLiveRampAuthProbe.missing_fields);
  const controlledLiveRampMode = String(controlledLiveRampGate.mode || "unavailable");
  const controlledLiveRampTone = controlledLiveRampAllowed
    ? controlledLiveRampMode === "probe" ? "subtle" : "good"
    : "warn";
  const controlledLiveRampBlockReasons = asStringArray(controlledLiveRampGate.block_reasons);
  const controlledLiveRampYellowFlags = asStringArray(controlledLiveRampGate.yellow_flags);
  const controlledLiveRampSummary = controlledLiveRampAllowed
    ? `${controlledLiveRampMode} · x${toNumber(controlledLiveRampGate.max_notional_multiplier, 0).toFixed(2)} notional · next ${String(controlledLiveRampGate.promotion_target || "micro_live")}`
    : !controlledLiveRampOpsVerdictAvailable
      ? `ops verdict unavailable · ${controlledLiveRampOpsUnavailableReasons.slice(0, 2).join(" · ") || "observability"}`
      : controlledLiveRampBlockReasons.slice(0, 2).join(" · ") || "controlled ramp blocked";
  const alerts = Array.isArray(snapshot.alerts) ? snapshot.alerts : [];
  const backendMode = String(governance.backend_mode || "guarded_auto");
  const modeConfig = asRecord(systemModePayload);
  const modeConfigMode = isSystemMode(modeConfig.system_mode) ? modeConfig.system_mode : null;
  const effectiveBackendMode = systemModeOverride || modeConfigMode || backendMode;
  const killSwitchEnvelope = asRecord(killSwitchPayload);
  const killSwitchState = asRecord(killSwitchEnvelope.state);
  const watchdogTriggers = Array.isArray(watchdog.triggers) ? watchdog.triggers.map((item) => String(item)) : [];
  const killSwitchSignalActive = watchdogTriggers.includes("kill_switch_active")
    || alerts.some((item) => {
      const alert = asRecord(item);
      return String(alert.code || "") === "kill_switch_active"
        || String(alert.detail || "").includes("kill_switch_active")
        || String(alert.message || "").toLowerCase().includes("kill switch");
    });
  const killSwitchActive = Boolean(killSwitchState.active) || killSwitchSignalActive;
  const killSwitchReason = String(killSwitchState.reason || (killSwitchSignalActive ? "runtime_truth_blocked" : "execution_locked"));
  const alphaMt5Symbol = resolveFtmoAutoSymbol(String(snapshot.generated_at || ""));
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
  const mt5PendingApprovals = unwrapRows(mt5PendingPayload)
    .map((row) => ({
      approvalId: String(row.approval_id || ""),
      accountId: String(row.account_id || "-"),
      firstApprovedBy: String(row.first_approved_by || "-"),
      createdAt: String(row.created_at || ""),
      orderPayload: asRecord(row.order_payload),
    }))
    .filter((row) => row.approvalId)
    .slice(0, 5);
  const predictorAnalytics = asRecord(predictorAnalyticsPayload);
  const predictorAcceptanceRatePct = toNumber(predictorAnalytics.predictor_acceptance_rate_pct, 0);
  const predictorEvaluatedTotal = toNumber(predictorAnalytics.predictor_evaluated_total, 0);
  const predictorAcceptedTotal = toNumber(predictorAnalytics.predictor_accepted_total, 0);
  const predictorRejectedTotal = toNumber(predictorAnalytics.predictor_rejected_total, 0);
  const predictorWindowDays = toNumber(predictorAnalytics.window_days, 30);
  const predictorSourceDiagnostics = asRecord(predictorAnalytics.source_diagnostics);
  const predictorAcceptanceTone = toneClassForPct(predictorAcceptanceRatePct);
  const predictorCauseRows = asRecordArray(predictorAnalytics.top_rejection_causes).slice(0, 6);
  const predictorSymbolRows = asRecordArray(predictorAnalytics.symbol_rows).slice(0, 4);
  const predictorSessionRows = asRecordArray(predictorAnalytics.session_rows).slice(0, 4);
  const predictorRegimeRows = asRecordArray(predictorAnalytics.regime_rows)
    .filter((row) => String(row.key || "") !== "unknown")
    .slice(0, 4);
  const predictorHourRows = [...asRecordArray(predictorAnalytics.hour_rows)]
    .sort((left, right) => {
      if (toNumber(right.rejected_total, 0) !== toNumber(left.rejected_total, 0)) {
        return toNumber(right.rejected_total, 0) - toNumber(left.rejected_total, 0);
      }
      return toNumber(right.evaluated_total, 0) - toNumber(left.evaluated_total, 0);
    })
    .slice(0, 4);
  const predictorAnalyticsReady = predictorEvaluatedTotal > 0 || predictorCauseRows.length > 0;
  const nowMs = Date.now();
  const recentWindowMs = 24 * 60 * 60 * 1000;
  const telemetryRows = unwrapRows(executionTelemetryPayload);
  const recentTelemetryRows = telemetryRows.filter((row) => {
    const timestamp = valueTimeMs(row);
    return timestamp > 0 && nowMs - timestamp <= recentWindowMs;
  });
  const recentMt5TelemetryRows = recentTelemetryRows.filter((row) => {
    const venueText = `${String(row.venue || "")} ${String(row.provider || "")} ${String(row.execution_mode || "")} ${String(row.route || "")}`.toLowerCase();
    return venueText.includes("mt5") || Boolean(row.broker_ticket) || Boolean(row.ts_broker_accept);
  });
  const recentOutcomeRows = unwrapRows(recentOutcomesPayload).filter((row) => {
    const timestamp = valueTimeMs(row);
    return timestamp > 0 && nowMs - timestamp <= recentWindowMs;
  });
  const recentGapRows = unwrapRows(recentGapPayload).filter((row) => {
    const timestamp = valueTimeMs(row);
    return timestamp > 0 && nowMs - timestamp <= recentWindowMs;
  });
  const recentAckCount = recentMt5TelemetryRows.filter((row) => Boolean(row.ts_broker_accept || row.broker_ticket || row.accepted_at)).length;
  const recentFillRows = recentMt5TelemetryRows.filter((row) => Boolean(row.ts_fill_final || row.filled_at || row.fill_count || row.avg_fill_price));
  const recentFillCount = recentFillRows.length;
  const recentOutcomeCount = recentOutcomeRows.length;
  const recentGapCount = recentGapRows.length;
  const recentFillDecisionIds = new Set(
    recentFillRows
      .map((row) => String(row.decision_id || row.intent_id || row.approval_id || row.broker_ticket || "").trim())
      .filter(Boolean),
  );
  const recentOutcomeDecisionIds = new Set(
    recentOutcomeRows
      .map((row) => String(row.decision_id || row.intent_id || row.approval_id || row.broker_ticket || "").trim())
      .filter(Boolean),
  );
  const recentGapDecisionIds = new Set(
    recentGapRows
      .map((row) => String(row.decision_id || row.intent_id || row.approval_id || row.broker_ticket || "").trim())
      .filter(Boolean),
  );
  const recentLinkedLoopCount = [...recentFillDecisionIds].filter((id) => recentOutcomeDecisionIds.has(id) && recentGapDecisionIds.has(id)).length;
  const alphaProofSteps = [
    { id: "ACK", label: "ACK broker", count: recentAckCount, done: recentAckCount > 0 },
    { id: "FILL", label: "FILL reel", count: recentFillCount, done: recentFillCount > 0 },
    { id: "OUTCOME", label: "Outcome", count: recentOutcomeCount, done: recentOutcomeCount > 0 },
    { id: "GAP", label: "Reality Gap", count: recentGapCount, done: recentGapCount > 0 },
    { id: "LINK", label: "Boucle liee", count: recentLinkedLoopCount, done: recentLinkedLoopCount > 0 },
  ];
  const alphaNextAction = killSwitchActive
    ? "Reset kill switch avant demande"
    : recentAckCount <= 0
    ? "Créer une demande micro-fill MT5"
    : recentFillCount <= 0
      ? "Approuver/executer pour obtenir le FILL"
      : recentOutcomeCount <= 0 || recentGapCount <= 0
        ? "Attendre ou réparer Outcome/GAP"
        : recentLinkedLoopCount <= 0
          ? "Relier decision_id / broker_ticket"
          : "Accumuler REAL_10";
  const alphaSubmitBlockedReason = killSwitchActive
    ? `Kill switch actif: ${killSwitchReason}. Aucune approval ne sera creee tant que le verrou n'est pas reset.`
    : effectiveBackendMode !== "managed_live"
      ? "Passe en Managed Live avant de creer une demande MT5 reelle."
      : "";
  const alphaPanelTone = recentFillCount > 0 && recentLinkedLoopCount > 0
    ? "good"
    : mt5PendingApprovals.length > 0
      ? "warn"
      : "subtle";
  const marketTruthLayer = asRecord(runtimeTruthLayers.market_truth);
  const executionRealityLayer = asRecord(runtimeTruthLayers.execution_reality);
  const executionRealityGovernanceLayer = asRecord(runtimeTruthLayers.execution_reality_governance);
  const finalDecisionTruthLayer = asRecord(runtimeTruthLayers.final_decision_truth);
  const confidenceLayer = asRecord(finalDecisionTruthLayer.confidence);
  const marketTruthScorePct = toNumber(marketTruthLayer.score_pct, 0);
  const executionQualityPct = toNumber(
    asRecord(executionRealityLayer.metrics).execution_quality_score_pct,
    toNumber(executionRealityLayer.score_pct, 0),
  );
  const regimeContribution = Math.round(Math.max(0, Math.min(24, marketTruthScorePct * 0.24)));
  const executionContribution = Math.round(Math.max(0, Math.min(18, executionQualityPct * 0.18)));
  const confidenceContribution = Math.round(Math.max(0, Math.min(22, toNumber(confidenceLayer.final_score_pct, 0) * 0.22)));
  const governanceContribution = backendMode === "managed_live" ? 12 : backendMode === "guarded_auto" ? 6 : 2;
  const proofNeedContribution = recentFillCount <= 0 ? 14 : 4;
  const approvalRiskPenalty = mt5PendingApprovals.length > 0 ? 8 : 0;
  const spreadRiskPenalty = Math.round(Math.max(0, Math.min(8, avgSlippageBps > 4 ? 8 : avgSlippageBps > 3 ? 5 : avgSlippageBps > 2 ? 3 : 0)));
  const executionGovPenalty = String(executionRealityGovernanceLayer.state || "").toUpperCase() === "LOCKDOWN" ? 12 : 0;
  const opportunityScore = Math.max(
    0,
    Math.min(
      100,
      20
      + regimeContribution
      + executionContribution
      + confidenceContribution
      + governanceContribution
      + proofNeedContribution
      - approvalRiskPenalty
      - spreadRiskPenalty
      - executionGovPenalty,
    ),
  );
  const opportunityDrivers = [
    { label: "Regime", value: regimeContribution },
    { label: "Execution", value: executionContribution },
    { label: "Confidence", value: confidenceContribution },
    { label: "Governance", value: governanceContribution },
    { label: "Proof need", value: proofNeedContribution },
  ];
  const opportunityRisks = [
    { label: "Approval pending", value: -approvalRiskPenalty },
    { label: "Spread/slippage", value: -spreadRiskPenalty },
    { label: "Execution governance", value: -executionGovPenalty },
  ].filter((item) => item.value < 0);
  const truthLine = (() => {
    const runtimeTruthVerdict = String(runtimeTruth.verdict || "").toUpperCase();
    if (runtimeTruthVerdict === "BLOCKED") {
      return { label: "BLOCK", tone: "warn", detail: String(runtimeTruth.summary || "runtime truth canonical block") };
    }
    if (runtimeTruthVerdict === "DEGRADED") {
      return { label: "REDUCE", tone: "subtle", detail: String(runtimeTruth.summary || "runtime truth degraded") };
    }
    if (runtimeTruthVerdict === "READY") {
      return { label: "OK", tone: "good", detail: String(runtimeTruth.summary || "runtime truth ready") };
    }
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
  const microLiveChecklistItems = [
    {
      label: "Entree",
      tone: microLiveEntryTone,
      detail: microLiveEntrySummary,
    },
    {
      label: "Coupe-circuits",
      tone: microLiveActiveCutSwitches.length === 0 ? "good" : "warn",
      detail: microLiveActiveCutSwitches.length === 0 ? "Aucun actif" : microLiveActiveCutSwitches.slice(0, 2).join(" · "),
    },
    {
      label: "Progression 100/50",
      tone: completeDecisionTotal >= microLiveCompleteTarget && createdDecisionTotal >= microLiveCreatedTarget ? "good" : (createdDecisionTotal > 0 || completeDecisionTotal > 0) ? "subtle" : "warn",
      detail: `created ${createdDecisionTotal}/${microLiveCreatedTarget} · complete ${completeDecisionTotal}/${microLiveCompleteTarget}`,
    },
    {
      label: "Fermeture",
      tone: rootCauseClosureRatePct >= 80 && allocationClosureRatePct >= 50 ? "good" : rootCauseClosureRatePct >= 50 || allocationClosureRatePct >= 25 ? "subtle" : "warn",
      detail: `allocation ${allocationClosureRatePct.toFixed(1)}% · root cause ${rootCauseClosureRatePct.toFixed(1)}%`,
    },
  ];
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
      focus: "Ouvrir une collecte controlee, pas chercher un PnL heroique",
      objective: `${collectionClassifiedCount}/${collectionTargetMin} labels vers le seuil minimum`,
      context: `Mode ${collectionStatus} · stage ${collectionStage} · gate ${String(asRecord(governance.opportunity_gate).status || "unknown")}`,
      tasks: [
        { id: "preopen-check", title: "Valider pre-open", detail: `Kill switch ${watchdogStatus === "HALT" ? "a reset manuellement" : "neutralise"}, opportunity gate ${String(asRecord(governance.opportunity_gate).status || "unknown")}, mode ${backendMode}.` },
        { id: "size-fixed", title: "Verrouiller le scope", detail: "BingX uniquement, BTCUSDT uniquement, 7-7.5$ max, aucun scaling." },
        { id: "max-10-trades", title: "Limiter le flux", detail: "Chaque trade = data point. Max 10 trades, no-trade prioritaire si le contexte se degrade." },
        { id: "avoid-revenge", title: "Interdire les tweaks", detail: "Aucun tweak de strategie, aucun changement de seuil, aucun scalping de poursuite." },
      ],
    },
    {
      dayOffset: 1,
      title: "Jour 2 · Collecte disciplinee",
      focus: "Mesurer execution, slippage et qualite des labels avant toute idee de perf",
      objective: "Labels propres > resultat brut",
      context: `Latency ${avgLatencyMs.toFixed(0)}ms · slippage ${avgSlippageBps.toFixed(2)}bps · recent labels ${collectionRecentClassifiedCount}`,
      tasks: [
        { id: "latency-watch", title: "Surveiller latency", detail: `Reduire si latency > 120ms, stop infra si > 200ms.` },
        { id: "fills-review", title: "Verifier fills", detail: "Comparer fill rate et slippage reel avant d'autoriser un flux plus dense." },
        { id: "context-lock", title: "Respecter le contexte", detail: "Si volatilite spike + liquidite faible, repasse en NO TRADE sans changer de strategie." },
        { id: "close-check", title: "Cloture sobre", detail: "Pas de trade de rattrapage et pas de changement de venue/instrument en fin de session." },
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
      context: "Confidence floor, fill probability floor et latency threshold sont les seuls leviers autorises.",
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

  const decisionTrace = asRecord(decisionTracePayload);
  const decisionTraceSummary = asRecord(decisionTrace.summary);
  const decisionTraceOracle = asRecord(decisionTrace.oracle_stability);
  const decisionTraceDiagnostics = asRecord(decisionTrace.diagnostics);
  const decisionTraceRequestedIds = asRecord(decisionTraceDiagnostics.requested_ids);
  const decisionTraceSteps = Array.isArray(decisionTrace.causal_steps) ? decisionTrace.causal_steps as JsonMap[] : [];
  const decisionTraceFacts = Array.isArray(decisionTrace.projected_facts) ? decisionTrace.projected_facts as JsonMap[] : [];
  const decisionTracePhases = Array.isArray(decisionTraceDiagnostics.phases) ? decisionTraceDiagnostics.phases as JsonMap[] : [];
  const decisionTraceMode = String(decisionTrace.mode || "lite");
  const decisionTraceResolvedVia = String(decisionTraceDiagnostics.resolved_via || "-");
  const decisionTraceTotalDurationMs = toNumber(decisionTraceDiagnostics.total_duration_ms, 0);
  const decisionTracePartial = Boolean(decisionTraceDiagnostics.partial);
  const decisionTraceStepsByKey = new Map(decisionTraceSteps.map((step) => [String(step.stage_key || "").trim(), step]));
  const decisionTraceTimeline = DECISION_TRACE_EXPLORER_STAGES.map((stage) => {
    const existing = decisionTraceStepsByKey.get(stage.key);
    if (existing) {
      return existing;
    }
    return {
      stage_key: stage.key,
      label: stage.label,
      status: "missing",
      timestamp: null,
      event_category: null,
      detail: stage.missingDetail,
      actors: [],
      payload: {},
    } as JsonMap;
  });
  const decisionTraceCompletedCount = decisionTraceTimeline.filter((step) => String(step.status || "") === "completed").length;
  const decisionTraceMissingLabels = decisionTraceTimeline
    .filter((step) => String(step.status || "") === "missing")
    .map((step) => String(step.label || step.stage_key || "step"));
  const decisionTraceBlockedLabels = decisionTraceTimeline
    .filter((step) => String(step.status || "") === "blocked")
    .map((step) => String(step.label || step.stage_key || "step"));
  const decisionTracePendingLabels = decisionTraceTimeline
    .filter((step) => String(step.status || "") === "pending")
    .map((step) => String(step.label || step.stage_key || "step"));
  const decisionTraceSlaMet = decisionTraceTotalDurationMs > 0 && decisionTraceTotalDurationMs <= 10_000;

  useEffect(() => {
    if (decisionTraceCandidateIds.length === 0) {
      setSelectedDecisionTraceId("");
      setDecisionTracePayload(null);
      setDecisionTraceError(null);
      return;
    }
    setSelectedDecisionTraceId((current) => (decisionTraceCandidateIds.includes(current) ? current : decisionTraceCandidateIds[0]));
  }, [decisionTraceCandidateIds.join("|")]);

  useEffect(() => {
    if (!selectedDecisionTraceId) {
      return;
    }
    void loadDecisionTrace(selectedDecisionTraceId);
  }, [selectedDecisionTraceId]);

  useEffect(() => {
    if (!selectedDecisionTraceId) {
      return;
    }
    setDecisionTraceQueryInput(selectedDecisionTraceId);
  }, [selectedDecisionTraceId]);

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

  if (!hydrated || !liveOpsPayload) {
    return (
      <main className="shell txt-page-shell" data-testid="mission-control-live-ops-page">
        <section className="panel txt-page-hero">
          <div className="eyebrow">TXT</div>
          <h1 className="title" style={{ fontSize: 34 }}>Synchronisation Live Ops</h1>
          <p className="subtle">La salle de controle charge le snapshot runtime. Si un endpoint est lent, l'etat operateur reste en mode degrade plutot que de bloquer une action.</p>
          {error ? <p className="warn">{error}</p> : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
            <button type="button" disabled={busy} onClick={() => { void loadData(); }}>
              {busy || loading ? "Synchronisation..." : "Reessayer"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell txt-page-shell" data-testid="mission-control-live-ops-page">
      <section className="hero txt-page-hero-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <div className="panel txt-page-hero">
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
            <Link href="/dashboard">Dashboard</Link>
            {" | "}
            <Link href="/terminal">Terminal</Link>
            {" | "}
            <Link href="/live-readiness">{UI_TERMS.readiness}</Link>
            {" | "}
            <Link href="/incidents">Incidents</Link>
          </p>
          {error ? <p className="warn">{error}</p> : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Etat Global</div>
          <div style={{ marginTop: 10, marginBottom: 10, borderRadius: 12, border: "1px solid rgba(56, 189, 248, 0.22)", padding: 12, background: "rgba(8, 47, 73, 0.22)" }}>
            <div className="subtle mini">Allocation Writer Closure Program</div>
            <div className={allocationClosureRateTone} style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{allocationClosureRatePct.toFixed(1)}%</div>
            <div className="subtle mini" style={{ marginTop: 4 }}>Primary KPI · Allocation Closure Rate · closed {toNumber(allocationWriterStateMachine.allocation_closed_total, 0)} / created {toNumber(allocationWriterStateMachine.allocation_created_total, 0)} · open {toNumber(allocationWriterStateMachine.allocation_open_total, 0)}</div>
            <div className="subtle mini" style={{ marginTop: 4 }}>Secondary KPI · Root Cause Closure Rate {rootCauseClosureRatePct.toFixed(1)}% · concentration {rootCauseConcentrationPct.toFixed(1)}% · dominant root cause {dominantRootCauseLabel}</div>
            <div className="subtle mini" style={{ marginTop: 4 }}>Journey completion {journeyCompletionRatePct.toFixed(1)}% · native evidence {evidenceNativePct.toFixed(1)}% · TRI indicator {truthReliabilityScorePct.toFixed(1)}%</div>
            {truthReliabilityCapPct !== null ? (
              <div className="subtle mini" style={{ marginTop: 4 }}>
                cap {truthReliabilityCapPct.toFixed(0)}% · {truthReliabilityCapReasons.join(" · ") || "critical fracture guard"}
              </div>
            ) : null}
          </div>
          <div className="row"><span>Watchdog</span><span className={String(watchdog.status || "UNKNOWN") === "OK" ? "good" : "warn"}>{String(watchdog.status || "UNKNOWN")}</span></div>
          <div className="row"><span>Health score</span><span>{toNumber(watchdog.health_score, 0).toFixed(0)}%</span></div>
          <div className="row"><span>System mode</span><span className={String(governance.mode || "SAFE") === "LIVE" ? "good" : String(governance.mode || "SAFE") === "LOCKED" ? "warn" : "subtle"}>{String(governance.mode || "SAFE")}</span></div>
          <div className="row"><span>Backend mode</span><span>{backendMode}</span></div>
          <div className="row"><span>Recovery</span><span>{String(recovery.mode || "NOMINAL")}</span></div>
          <div className="row"><span>Allocation closure</span><span className={allocationClosureRateTone}>{allocationClosureRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Root cause closure</span><span className={rootCauseClosureRateTone}>{rootCauseClosureRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Root cause concentration</span><span className={rootCauseConcentrationTone}>{rootCauseConcentrationPct.toFixed(1)}%</span></div>
          <div className="row"><span>Complete / created</span><span>{completeDecisionTotal} / {createdDecisionTotal}</span></div>
          <div className="row"><span>Native evidence coverage</span><span className={toneClassForPct(evidenceNativePct)}>{evidenceNativePct.toFixed(1)}%</span></div>
          <div className="row"><span>TRI indicator</span><span className={toneClassForPct(truthReliabilityScorePct)}>{truthReliabilityScorePct.toFixed(1)}% · {truthReliabilityStatus}</span></div>
          <div className="row"><span>Spine match</span><span className={toneClassForPct(toNumber(truthReliabilityComponents.spine_match_rate_pct, 0))}>{toNumber(truthReliabilityComponents.spine_match_rate_pct, 0).toFixed(1)}%</span></div>
          <div className="row"><span>Memory gate</span><span className={String(memoryGap.memory_decision || "OK") === "OK" ? "good" : "warn"}>{String(memoryGap.memory_decision || "OK")}</span></div>
          <div className="row"><span>Alertes live</span><span>{String(alerts.length)}</span></div>
          <div className="row"><span>Refresh</span><span>{loading ? "bootstrap" : busy ? "sync" : "15s"}</span></div>
        </div>
        <div className="panel">
          <div className="eyebrow">Source Tree Provenance Audit</div>
          <div className="subtle" style={{ marginTop: 6 }}>La chaine workspace vers build puis runtime puis slot actif n est consideree prouvee que si les quatre commits convergent.</div>
          <div className="row"><span>status</span><span className={toneClassForPct(sourceTreeCommitAlignmentRatePct)}>{formatSourceTreeProvenanceStatus(sourceTreeProvenanceNormalized.status)}</span></div>
          <div className="row"><span>workspace_commit</span><span>{formatCommitHash(sourceTreeProvenance.workspace_commit)}</span></div>
          <div className="row"><span>build_commit</span><span>{formatCommitHash(sourceTreeProvenance.build_commit)}</span></div>
          <div className="row"><span>runtime_commit</span><span>{formatCommitHash(sourceTreeProvenance.runtime_commit)}</span></div>
          <div className="row"><span>active_slot_commit</span><span>{formatCommitHash(sourceTreeProvenance.active_slot_commit)}</span></div>
          <div className="row"><span>commit_alignment_rate</span><span className={toneClassForPct(sourceTreeCommitAlignmentRatePct)}>{sourceTreeCommitAlignmentRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>publish_blocked</span><span className={Boolean(sourceTreeProvenance.publish_blocked) ? "warn" : "good"}>{Boolean(sourceTreeProvenance.publish_blocked) ? "yes" : "no"}</span></div>
          <div className="row"><span>certification_cap_pct</span><span className={toneClassForPct(toNumber(sourceTreeCertification.cap_pct, 0))}>{toNumber(sourceTreeCertification.cap_pct, 0).toFixed(1)}%</span></div>
          <div className="row"><span>certified_tri_pct</span><span className={toneClassForPct(toNumber(sourceTreeCertification.certified_tri_pct, 0))}>{toNumber(sourceTreeCertification.certified_tri_pct, 0).toFixed(1)}%</span></div>
          <div className="row"><span>certified_journey_completion_pct</span><span className={toneClassForPct(toNumber(sourceTreeCertification.certified_journey_completion_pct, 0))}>{toNumber(sourceTreeCertification.certified_journey_completion_pct, 0).toFixed(1)}%</span></div>
          <div className="row"><span>healthy_alignment_hours_30d</span><span>{toNumber(sourceTreeProvenance30d.healthy_alignment_hours, 0).toFixed(1)}h</span></div>
          <div className="row"><span>governance_breach_count_30d</span><span className={toNumber(sourceTreeProvenance30d.governance_breach_count, 0) > 0 ? "warn" : "good"}>{toNumber(sourceTreeProvenance30d.governance_breach_count, 0)}</span></div>
          <div className="row"><span>longest_divergence_period_30d</span><span>{toNumber(sourceTreeProvenance30d.longest_divergence_period_hours, 0).toFixed(1)}h</span></div>
          <div className="row"><span>healthy_alignment_hours_7d</span><span>{toNumber(sourceTreeProvenance7d.healthy_alignment_hours, 0).toFixed(1)}h</span></div>
          <div className="row"><span>governance_breach_count_7d</span><span className={toNumber(sourceTreeProvenance7d.governance_breach_count, 0) > 0 ? "warn" : "good"}>{toNumber(sourceTreeProvenance7d.governance_breach_count, 0)}</span></div>
          <div className="subtle mini" style={{ marginTop: 8 }}>{String(sourceTreeCertification.rule || "")}</div>
          {sourceTreeCommitDelta.length > 0 ? <div className="subtle mini" style={{ marginTop: 8 }}>Delta commit · {sourceTreeCommitDelta.join(" · ")}</div> : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel" data-testid="live-ops-predictor-rejection-analytics-panel">
          <OperatorPanelGuide
            title="Predictor Rejection Analytics"
            what="Mesure les decisions micro-live vraiment evaluees par le predictor apres Approval #2."
            why="Distinguer le verrou predictor du reste de la chaine et prioriser les causes de rejet qui plafonnent le micro-live."
            example="Si l'infra est GO mais que l'acceptance rate predictor reste bas, le prochain travail est sur la qualification predictor, pas sur le bridge ou le broker."
            compact
          />
          <div className="row" style={{ marginTop: 10 }}><span>Acceptance rate</span><span className={predictorAcceptanceTone}>{predictorAcceptanceRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Predictor evaluated</span><span>{predictorEvaluatedTotal}</span></div>
          <div className="row"><span>Accepted</span><span className={predictorAcceptedTotal > 0 ? "good" : "subtle"}>{predictorAcceptedTotal}</span></div>
          <div className="row"><span>Rejected</span><span className={predictorRejectedTotal > 0 ? "warn" : "subtle"}>{predictorRejectedTotal}</span></div>
          <div className="subtle mini" style={{ marginTop: 8 }}>
            Fenetre {predictorWindowDays} jours · journal scanne {toNumber(predictorSourceDiagnostics.rows_scanned, 0)} · decisions retenues {toNumber(predictorSourceDiagnostics.rows_returned, 0)}
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="subtle mini" style={{ marginBottom: 6 }}>Top causes de rejet predictor</div>
            {predictorAnalyticsReady && predictorCauseRows.length > 0 ? (
              <div style={{ display: "grid", gap: 8 }}>
                {predictorCauseRows.map((row) => (
                  <div key={String(row.reason_key || row.label || "unknown")} style={{ border: "1px solid rgba(148, 163, 184, 0.16)", borderRadius: 12, padding: 10, background: "rgba(15, 23, 42, 0.22)" }}>
                    <div className="row"><span>{String(row.label || formatReasonLabel(String(row.reason_key || "other")))}</span><span className="warn">{toNumber(row.count, 0)}</span></div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>
                      {toNumber(row.share_pct, 0).toFixed(1)}% des rejets · symboles {asStringArray(row.unique_symbols).join(", ") || "-"}
                    </div>
                  </div>
                ))}
              </div>
            ) : predictorAnalyticsError ? (
              <div className="warn mini">Contrat predictor en erreur: {predictorAnalyticsError}</div>
            ) : (
              <div className="subtle mini">Aucune decision predictor evaluee dans la fenetre locale. Le bloc se remplira des que le journal Approval #2 recense de nouveaux passages.</div>
            )}
          </div>
        </div>
        <div className="panel">
          <div className="eyebrow">Rejets par contexte</div>
          <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Par symbole</div>
              {predictorSymbolRows.length > 0 ? predictorSymbolRows.map((row) => (
                <div key={String(row.key || row.label || "symbol")} className="row" style={{ marginTop: 4 }}>
                  <span>{String(row.label || row.key || "-")}</span>
                  <span>{toNumber(row.accepted_total, 0)} acc · {toNumber(row.rejected_total, 0)} rej · {toNumber(row.acceptance_rate_pct, 0).toFixed(1)}%</span>
                </div>
              )) : <div className="subtle mini">Aucune ligne symbole.</div>}
            </div>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Par session</div>
              {predictorSessionRows.length > 0 ? predictorSessionRows.map((row) => (
                <div key={String(row.key || row.label || "session")} className="row" style={{ marginTop: 4 }}>
                  <span>{String(row.label || row.key || "-")}</span>
                  <span>{toNumber(row.accepted_total, 0)} acc · {toNumber(row.rejected_total, 0)} rej</span>
                </div>
              )) : <div className="subtle mini">Aucune ligne session.</div>}
            </div>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Par regime</div>
              {predictorRegimeRows.length > 0 ? predictorRegimeRows.map((row) => (
                <div key={String(row.key || row.label || "regime")} className="row" style={{ marginTop: 4 }}>
                  <span>{String(row.label || row.key || "-")}</span>
                  <span>{toNumber(row.accepted_total, 0)} acc · {toNumber(row.rejected_total, 0)} rej</span>
                </div>
              )) : <div className="subtle mini">Aucun regime exploitable encore projete.</div>}
            </div>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Heures UTC les plus rejectives</div>
              {predictorHourRows.length > 0 ? predictorHourRows.map((row) => (
                <div key={String(row.key || row.label || "hour")} className="row" style={{ marginTop: 4 }}>
                  <span>{String(row.label || row.key || "-")}</span>
                  <span>{toNumber(row.rejected_total, 0)} rej · {toNumber(row.evaluated_total, 0)} eval</span>
                </div>
              )) : <div className="subtle mini">Aucune heure chaude detectee.</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel" data-testid="live-ops-micro-live-program-panel">
          <OperatorPanelGuide
            title="Micro-live gouverne"
            what="Statut d'entree, coupe-circuits et progression de preuve pour la session micro-live."
            why="Savoir en quelques secondes si la session peut ouvrir, rester bornee ou doit s'arreter."
            example="Si l'entree passe a BLOCKED ou qu'un coupe-circuit s'active, on stoppe les nouvelles entrees avant toute discussion de taille."
            compact
          />
          <div className="row" style={{ marginTop: 10 }}><span>Entree micro-live</span><span className={microLiveEntryTone}>{microLiveEntryStatus}</span></div>
          <div className="subtle mini" style={{ marginTop: 8 }}>{microLiveEntrySummary}</div>
          <div className="row" style={{ marginTop: 10 }}><span>Stage actif</span><span>{microLiveCurrentStage}</span></div>
          <div className="row"><span>Cap ordre stage</span><span>{formatUsd(microLiveStageCapUsd)}</span></div>
          <div className="row"><span>Bridge MT5</span><span className={String(microLiveInfrastructure.mt5_bridge_status || "unknown").toLowerCase() === "healthy" ? "good" : "warn"}>{String(microLiveInfrastructure.mt5_bridge_status || "unknown")}</span></div>
          <div className="row"><span>Connecteurs degrades</span><span className={toNumber(microLiveInfrastructure.degraded_connector_count, 0) > 0 ? "warn" : "good"}>{toNumber(microLiveInfrastructure.degraded_connector_count, 0)}</span></div>
          <div className="row"><span>Opportunity gate</span><span className={String(microLiveInfrastructure.opportunity_gate_status || "unknown").toLowerCase() === "go" ? "good" : "warn"}>{String(microLiveInfrastructure.opportunity_gate_status || "unknown")}</span></div>
          <div className="row"><span>Coupe-circuits actifs</span><span className={microLiveActiveCutSwitches.length === 0 ? "good" : "warn"}>{microLiveActiveCutSwitches.length}</span></div>
          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {microLiveActiveCutSwitches.length > 0 ? microLiveActiveCutSwitches.slice(0, 4).map((item) => (
              <div key={`micro-live-cut-switch-${item}`} className="subtle mini" style={{ border: "1px solid rgba(248, 113, 113, 0.18)", borderRadius: 10, padding: "8px 10px", background: "rgba(127, 29, 29, 0.12)" }}>
                {item}
              </div>
            )) : (
              <div className="subtle mini" style={{ border: "1px solid rgba(34, 197, 94, 0.18)", borderRadius: 10, padding: "8px 10px", background: "rgba(20, 83, 45, 0.12)" }}>
                Aucun coupe-circuit actif. La session reste toutefois bornee par la gouvernance et les caps de stage.
              </div>
            )}
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="row"><span>Created decisions</span><span>{createdDecisionTotal} / {microLiveCreatedTarget}</span></div>
            <div style={{ marginTop: 8, height: 8, borderRadius: 999, background: "rgba(148, 163, 184, 0.14)", overflow: "hidden" }}>
              <div style={{ width: `${microLiveCreatedProgressPct}%`, height: "100%", background: microLiveCreatedProgressPct >= 100 ? "linear-gradient(90deg, rgba(34,197,94,0.9), rgba(16,185,129,0.9))" : "linear-gradient(90deg, rgba(56,189,248,0.9), rgba(14,165,233,0.9))" }} />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="row"><span>Complete decisions</span><span>{completeDecisionTotal} / {microLiveCompleteTarget}</span></div>
            <div style={{ marginTop: 8, height: 8, borderRadius: 999, background: "rgba(148, 163, 184, 0.14)", overflow: "hidden" }}>
              <div style={{ width: `${microLiveCompleteProgressPct}%`, height: "100%", background: microLiveCompleteProgressPct >= 100 ? "linear-gradient(90deg, rgba(34,197,94,0.9), rgba(16,185,129,0.9))" : "linear-gradient(90deg, rgba(250,204,21,0.9), rgba(249,115,22,0.9))" }} />
            </div>
          </div>
          {microLiveTransitionHistory.length > 0 ? (
            <div className="subtle mini" style={{ marginTop: 10 }}>
              Derniere transition {String(microLiveTransitionHistory[0]?.from || "-")} -&gt; {String(microLiveTransitionHistory[0]?.to || "-")} · {formatDateTimeCompact(microLiveTransitionHistory[0]?.at)}
            </div>
          ) : null}
        </div>
        <div className="panel" data-testid="live-ops-micro-live-checklist-panel">
          <div className="eyebrow">Checklist operateur ultra-courte</div>
          <div className="subtle" style={{ marginTop: 6 }}>Quatre verifications maximum avant, pendant et a la cloture d'une session micro-live.</div>
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {microLiveChecklistItems.map((item) => (
              <div key={item.label} style={{ border: "1px solid rgba(148, 163, 184, 0.18)", borderRadius: 12, padding: 12, background: "rgba(15, 23, 42, 0.2)" }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <span>{item.label}</span>
                  <span className={item.tone}>{item.tone === "good" ? "OK" : item.tone === "warn" ? "STOP" : "REDUCE"}</span>
                </div>
                <div className="subtle mini">{item.detail}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(56, 189, 248, 0.22)", padding: 12, background: "rgba(8, 47, 73, 0.22)" }}>
            <div className="row"><span>Root cause dominante</span><span className={rootCauseConcentrationTone}>{dominantRootCauseLabel}</span></div>
            <div className="row"><span>Allocation closure</span><span className={allocationClosureRateTone}>{allocationClosureRatePct.toFixed(1)}%</span></div>
            <div className="row"><span>Root cause closure</span><span className={rootCauseClosureRateTone}>{rootCauseClosureRatePct.toFixed(1)}%</span></div>
            <div className="row"><span>Native evidence</span><span className={toneClassForPct(evidenceNativePct)}>{evidenceNativePct.toFixed(1)}%</span></div>
          </div>
          <div className="subtle mini" style={{ marginTop: 10 }}>
            Bucket {microLiveStageBuckets.length} · backend {String(microLiveInfrastructure.backend_mode || backendMode)} · truth line {truthLine.label}
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Canonical Spine</div>
          <div className="row"><span>Spine match rate</span><span className={toneClassForPct(spineMatchRatePct)}>{spineMatchRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Allocation -&gt; Approval</span><span className={toneClassForPct(spineApprovalLinkRatePct)}>{spineApprovalLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Approval -&gt; Hardening</span><span className={toneClassForPct(spineHardeningLinkRatePct)}>{spineHardeningLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Approval -&gt; Execution</span><span className={toneClassForPct(spineApprovalExecutionLinkRatePct)}>{spineApprovalExecutionLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Allocation -&gt; Execution</span><span className={toneClassForPct(spineAllocationLinkRatePct)}>{spineAllocationLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Execution -&gt; Outcome</span><span className={toneClassForPct(spineExecutionLinkRatePct)}>{spineExecutionLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Outcome -&gt; Attribution</span><span className={toneClassForPct(spineOutcomeLinkRatePct)}>{spineOutcomeLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Refusal eligible -&gt; Opportunity</span><span className={toneClassForPct(spineOpportunityLinkRatePct)}>{spineOpportunityLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Refusal brut -&gt; Opportunity</span><span className={toneClassForPct(spineOpportunityLinkRateRawPct)}>{spineOpportunityLinkRateRawPct.toFixed(1)}%</span></div>
          <div className="row"><span>Refusal brut post-producteur</span><span className={toneClassForPct(spineOpportunityLinkRatePostProducerPct)}>{spineOpportunityLinkRatePostProducerPct.toFixed(1)}%</span></div>
          <div className="row"><span>Execution source -&gt; Fact</span><span className={toneClassForPct(spineExecutionDerivationRatePct)}>{spineExecutionDerivationRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Matching follow-up attendu</span><span className={toneClassForPct(spineFollowupMatchingRatePct)}>{spineFollowupMatchingRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Opportunity scored / pending</span><span className={toneClassForPct(spineMatchingRatePct)}>{toNumber(canonicalSpine.opportunity_scored_total, 0)} / {toNumber(canonicalSpine.opportunity_pending_total, 0)}</span></div>
          <div className="row"><span>Alpha attribution coverage</span><span className={toneClassForPct(spineAlphaCoveragePct)}>{spineAlphaCoveragePct.toFixed(1)}%</span></div>
          <div className="row"><span>Allocation writes 24h</span><span>{toNumber(canonicalSpine.allocation_decisions_24h, 0)}</span></div>
          <div className="row"><span>Execution facts 24h</span><span>{toNumber(canonicalSpine.execution_facts_24h, 0)}</span></div>
          <div className="row"><span>Opportunity logical 24h</span><span>{toNumber(canonicalSpine.opportunity_entries_24h, 0)}</span></div>
          <div className="row"><span>Strategies 24h</span><span>{toNumber(canonicalSpine.unique_strategies_24h, 0)}</span></div>
          {spineOperationalRefusalByCode.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Refus operationnels 30j</div>
              {spineOperationalRefusalByCode.map((item, index) => (
                <div key={`${String(item.code || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.code || "unknown")}</span>
                  <span className="warn">{toNumber(item.count, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {spineOperationalRefusalByCodePostProducer.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Refus operationnels post-producteur</div>
              {spineOperationalRefusalByCodePostProducer.map((item, index) => (
                <div key={`${String(item.code || "unknown")}-post-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.code || "unknown")}</span>
                  <span className="warn">{toNumber(item.count, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {spinePendingByGate.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Pending principaux</div>
              {spinePendingByGate.map((item, index) => (
                <div key={`${String(item.gate || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate || "unknown")}</span>
                  <span className="warn">{toNumber(item.count, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Reliability Governance Program</div>
          <div className="subtle" style={{ marginTop: 6 }}>Le signal principal n est plus le volume de gaps mais la concentration de responsabilite. Ici, le backlog a ete compresse en cause structurelle actionnable.</div>
          <div style={{ marginTop: 10, marginBottom: 12, borderRadius: 12, border: "1px solid rgba(248, 113, 113, 0.18)", padding: 12, background: "rgba(127, 29, 29, 0.12)" }}>
            <div className="subtle mini">341 symptomes, 1 maladie quand la concentration atteint le plafond operatoire.</div>
            <div className={rootCauseConcentrationTone} style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{rootCauseConcentrationPct.toFixed(1)}%</div>
            <div className="subtle mini" style={{ marginTop: 4 }}>Root Cause Concentration actuelle · dominant root cause {dominantRootCauseLabel}</div>
          </div>
          <div className="row"><span>Decision Journey Completion Rate</span><span className={toneClassForPct(journeyCompletionRatePct)}>{journeyCompletionRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Decision Evidence Native</span><span className={toneClassForPct(evidenceNativePct)}>{evidenceNativePct.toFixed(1)}%</span></div>
          <div className="row"><span>Dominant Root Cause</span><span className={rootCauseConcentrationTone}>{dominantRootCauseLabel}</span></div>
          <div className="row"><span>Root Cause Concentration</span><span className={rootCauseConcentrationTone}>{rootCauseConcentrationPct.toFixed(1)}%</span></div>
          <div className="row"><span>Current occurrences</span><span className="warn">{toNumber(dominantRootCauseCurrent?.open_gap_total, 0)}</span></div>
          <div className="row"><span>Current unique root causes</span><span>{toNumber(dominantGapCardinality.unique_root_cause_total, 0)}</span></div>
          <div className="row"><span>7j concentration avg</span><span className={rootCauseConcentration7dPct >= 80 ? "warn" : rootCauseConcentration7dPct >= 40 ? "subtle" : "good"}>{rootCauseConcentration7dPct.toFixed(1)}%</span></div>
          <div className="row"><span>30j concentration avg</span><span className={rootCauseConcentration30dPct >= 80 ? "warn" : rootCauseConcentration30dPct >= 40 ? "subtle" : "good"}>{rootCauseConcentration30dPct.toFixed(1)}%</span></div>
          <div className="row"><span>Evidence pipeline</span><span>N {toNumber(decisionEvidenceQuality.native, 0)} / B {toNumber(decisionEvidenceQuality.backfilled, 0)} / I {toNumber(decisionEvidenceQuality.inferred, 0)} / M {toNumber(decisionEvidenceQuality.missing, 0)}</span></div>
          <div className="subtle mini" style={{ marginTop: 10 }}>Quand la concentration descend de 100% vers 60% puis 20%, le systeme passe d un defaut systemique a des defauts localises.</div>
        </div>
        <div className="panel">
          <div className="eyebrow">Decision Gap Reduction Campaign</div>
          <div className="subtle" style={{ marginTop: 6 }}>Le KPI directeur est le parcours complet de preuve. La campagne reduit le first missing stage dominant sprint apres sprint.</div>
          <div className="row"><span>Observed lifecycle keys</span><span>{lifecycleObservedTotal}</span></div>
          <div className="row"><span>Created decisions</span><span>{createdDecisionTotal}</span></div>
          <div className="row"><span>Complete decisions</span><span className={completeDecisionTotal > 0 ? "good" : "warn"}>{completeDecisionTotal}</span></div>
          <div className="row"><span>Incomplete decisions</span><span className={incompleteDecisionTotal > 0 ? "warn" : "good"}>{incompleteDecisionTotal}</span></div>
          <div className="row"><span>Lifecycle publish gate</span><span className={lifecyclePublishBlocked ? "warn" : "good"}>{lifecyclePublishBlocked ? "blocked" : "clear"}</span></div>
          <div className="row"><span>Controlled live ramp gate</span><span className={controlledLiveRampTone}>{controlledLiveRampAllowed ? controlledLiveRampMode : "halted"}</span></div>
          <div className="row"><span>Terminal publish blocked</span><span className={terminalPublishBlocked ? "warn" : "good"}>{terminalPublishBlocked ? "yes" : "no"}</span></div>
          <div className="row"><span>Execution debt blocked</span><span className={executionGapBlockedDecisionTotal > 0 ? "warn" : "good"}>{executionGapBlockedDecisionTotal}</span></div>
          <div className="row"><span>Terminal closed total</span><span className={terminalClosedTotal > 0 ? "good" : "subtle"}>{terminalClosedTotal}</span></div>
          <div className="row"><span>Stale cancelled</span><span className={toNumber(terminalClosedStates.stale_cancelled, 0) > 0 ? "good" : "subtle"}>{toNumber(terminalClosedStates.stale_cancelled, 0)}</span></div>
          <div className="row"><span>Review required</span><span className={toNumber(terminalReviewRequired.total, toNumber(terminalDecisionStateDiagnostic.review_required_total, 0)) > 0 ? "subtle" : "good"}>{toNumber(terminalReviewRequired.total, toNumber(terminalDecisionStateDiagnostic.review_required_total, 0))}</span></div>
          <div className="row"><span>Decision Journey Completion Rate</span><span className={toneClassForPct(journeyCompletionRatePct)}>{journeyCompletionRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Institutional tier</span><span className={decisionContinuityGovernanceRule.tone}>{decisionContinuityGovernanceRule.label}</span></div>
          <div className="row"><span>First missing stage dominant</span><span className={decisionGapReductionDominantStage && toNumber(decisionGapReductionDominantStage.blocked_decision_total, 0) > 0 ? "warn" : "good"}>{decisionGapReductionDominantStage ? String(decisionGapReductionDominantStage.gap_label || decisionGapReductionDominantStage.label || "none") : "none"}</span></div>
          <div className="row"><span>7j dominant gap</span><span className={decisionGapReduction7dDominantStage ? "warn" : "good"}>{decisionGapReduction7dDominantStage ? `${String(decisionGapReduction7dDominantStage.gap_label || decisionGapReduction7dDominantStage.label || "unknown")} · ${toNumber(decisionGapReduction7dDominantStage.latest_blocked_decision_total, 0)} (${toNumber(decisionGapReduction7dDominantStage.blocked_decision_growth, 0) >= 0 ? "+" : ""}${toNumber(decisionGapReduction7dDominantStage.blocked_decision_growth, 0).toFixed(1)})` : "none"}</span></div>
          <div className="row"><span>30j dominant gap</span><span className={decisionGapReduction30dDominantStage ? "warn" : "good"}>{decisionGapReduction30dDominantStage ? `${String(decisionGapReduction30dDominantStage.gap_label || decisionGapReduction30dDominantStage.label || "unknown")} · ${toNumber(decisionGapReduction30dDominantStage.latest_blocked_decision_total, 0)} (${toNumber(decisionGapReduction30dDominantStage.blocked_decision_growth, 0) >= 0 ? "+" : ""}${toNumber(decisionGapReduction30dDominantStage.blocked_decision_growth, 0).toFixed(1)})` : "none"}</span></div>
          <div className="row"><span>Decision continuity score</span><span className={toneClassForPct(decisionContinuityScorePct)}>{decisionContinuityScorePct.toFixed(1)}%</span></div>
          <div className="row"><span>Link coverage score</span><span className={toneClassForPct(lifecycleCoverageScorePct)}>{lifecycleCoverageScorePct.toFixed(1)}%</span></div>
          <div className="row"><span>Allocation link rate</span><span className={toneClassForPct(lifecycleAllocationLinkRatePct)}>{lifecycleAllocationLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Approval link rate</span><span className={toneClassForPct(lifecycleApprovalLinkRatePct)}>{lifecycleApprovalLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Hardening link rate</span><span className={toneClassForPct(lifecycleHardeningLinkRatePct)}>{lifecycleHardeningLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Execution link rate</span><span className={toneClassForPct(lifecycleExecutionLinkRatePct)}>{lifecycleExecutionLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Outcome link rate</span><span className={toneClassForPct(lifecycleOutcomeLinkRatePct)}>{lifecycleOutcomeLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Attribution link rate</span><span className={toneClassForPct(lifecycleAttributionLinkRatePct)}>{lifecycleAttributionLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Opportunity link rate</span><span className={toneClassForPct(lifecycleOpportunityLinkRatePct)}>{lifecycleOpportunityLinkRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Evidence mix</span><span>N {toNumber(decisionEvidenceQuality.native, 0)} / B {toNumber(decisionEvidenceQuality.backfilled, 0)} / I {toNumber(decisionEvidenceQuality.inferred, 0)} / M {toNumber(decisionEvidenceQuality.missing, 0)}</span></div>
          <div className="row"><span>Causality confidence</span><span>N {toNumber(lifecycleCausalityConfidence.native, 0)} / B {toNumber(lifecycleCausalityConfidence.backfilled, 0)} / I {toNumber(lifecycleCausalityConfidence.inferred, 0)}</span></div>
          <div className="row"><span>Execution + Opportunity</span><span>{toNumber(tradeLifecycleHealth.cross_object_lifecycle_total, 0)}</span></div>
          <div style={{ marginTop: 12, borderRadius: 12, border: lifecyclePublishBlocked ? "1px solid rgba(248, 113, 113, 0.24)" : "1px solid rgba(34, 197, 94, 0.22)", padding: 12, background: lifecyclePublishBlocked ? "rgba(127, 29, 29, 0.12)" : "rgba(20, 83, 45, 0.14)" }}>
            <div className="subtle mini">Lifecycle publish gate gouverne par la verite metier terminale, pas par la dette structurelle brute.</div>
            <div className={lifecyclePublishBlocked ? "warn" : "good"} style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{lifecyclePublishBlocked ? "BLOCKED" : "CLEAR"}</div>
            <div className="subtle mini" style={{ marginTop: 4 }}>Terminal debt active {toNumber(terminalActiveDebt.hardening_not_reached, 0) + toNumber(terminalActiveDebt.hardening_rejected_without_reason, 0) + toNumber(terminalActiveDebt.approved_without_route, 0) + toNumber(terminalActiveDebt.routed_without_execution_event, 0) + toNumber(terminalActiveDebt.execution_without_outcome, 0)} · execution debt {executionGapBlockedDecisionTotal} · review blockers {toNumber(terminalReviewRequired.blocking_total, 0)}</div>
            {lifecyclePublishBlockReasons.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div className="subtle mini" style={{ marginBottom: 6 }}>publish_block_reasons</div>
                {lifecyclePublishBlockReasons.map((reason, index) => (
                  <div key={`publish-block-reason-${index}`} className="row" style={{ marginTop: 4 }}>
                    <span>{reason}</span>
                    <span className="warn">block</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="subtle mini" style={{ marginTop: 8 }}>publish_block_reasons: none</div>
            )}
          </div>
          <div style={{ marginTop: 12, borderRadius: 12, border: controlledLiveRampAllowed ? "1px solid rgba(34, 197, 94, 0.22)" : "1px solid rgba(248, 113, 113, 0.24)", padding: 12, background: controlledLiveRampAllowed ? "rgba(20, 83, 45, 0.14)" : "rgba(127, 29, 29, 0.12)" }}>
            <div className="subtle mini">controlled_live_ramp_gate agrège lifecycle, runtime truth, replay et public health avant promotion de taille.</div>
            <div className={controlledLiveRampTone} style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{controlledLiveRampAllowed ? "ALLOWED" : "HALTED"}</div>
            <div className="subtle mini" style={{ marginTop: 4 }}>{controlledLiveRampSummary}</div>
            <div className="row" style={{ marginTop: 8 }}><span>Ops verdict</span><span className={controlledLiveRampOpsVerdictAvailable ? "good" : "warn"}>{controlledLiveRampOpsVerdictAvailable ? "available" : "unavailable"}</span></div>
            <div className="row"><span>Ramp mode</span><span className={controlledLiveRampTone}>{controlledLiveRampMode}</span></div>
            <div className="row" style={{ marginTop: 8 }}><span>Clean cycles</span><span>{toNumber(controlledLiveRampGate.current_clean_cycles, 0)} / {toNumber(controlledLiveRampGate.required_clean_cycles, 3)}</span></div>
            <div className="row"><span>Runtime truth</span><span className={String(controlledLiveRampRuntimeTruthGate.verdict || "UNAVAILABLE") === "BLOCKED" ? "warn" : String(controlledLiveRampRuntimeTruthGate.verdict || "") === "DEGRADED" ? "subtle" : "good"}>{String(controlledLiveRampRuntimeTruthGate.verdict || "UNAVAILABLE")}</span></div>
            <div className="row"><span>Runtime matrix coverage</span><span className={String(controlledLiveRampRuntimeTruthMatrix.status || "") === "available" ? "good" : "warn"}>{toNumber(controlledLiveRampRuntimeTruthMatrixCoverage.available, 0)} / {toNumber(controlledLiveRampRuntimeTruthMatrixCoverage.required, 0)} · {String(controlledLiveRampRuntimeTruthMatrix.status || "unknown")}</span></div>
            <div className="row"><span>Settlement truth</span><span className={String(controlledLiveRampSettlementTruth.status || "") === "available" ? "good" : "warn"}>{String(controlledLiveRampSettlementTruth.status || "unknown")} · {String(controlledLiveRampSettlementTruth.repair_hint || controlledLiveRampSettlementTruth.source || "-")}</span></div>
            <div className="row"><span>Settlement source</span><span className={String(controlledLiveRampSettlementContextDiff.status || "") === "available" && controlledLiveRampSettlementContextDiff.ops_context_allowed !== false ? "good" : "warn"}>{String(controlledLiveRampSettlementContextDiff.source_context || "unknown")} · {String(controlledLiveRampSettlementContextDiff.http_status || "-")} · {String(controlledLiveRampSettlementContextDiff.resolved_url || controlledLiveRampSettlementContextDiff.expected_url || "-")}</span></div>
            <div className="row"><span>Settlement context</span><span className={controlledLiveRampSettlementContextDiff.ops_context_allowed === false ? "warn" : "good"}>{controlledLiveRampSettlementContextDiff.ops_context_allowed === false ? "ops route not allowed" : "ops route allowed"} · {String(controlledLiveRampSettlementContextDiff.repair_hint || "no repair hint")}</span></div>
            <div className="row"><span>Ops runner</span><span className={controlledLiveRampOpsRunnerContext.valid === false ? "warn" : "good"}>{controlledLiveRampOpsRunnerContext.valid === false ? "invalid" : "valid"} · {String(controlledLiveRampOpsRunnerContext.network_context || "unknown")} · {String(controlledLiveRampOpsRunnerContext.runner_service || "unknown")}</span></div>
            <div className="row"><span>Settlement mismatch</span><span className={controlledLiveRampSettlementContextDiff.missing_source_reason ? "warn" : "good"}>{String(controlledLiveRampSettlementContextDiff.missing_source_reason || "none")}</span></div>
            <div className="row"><span>Missing truth sources</span><span className={controlledLiveRampMissingRuntimeSources.length > 0 ? "warn" : "good"}>{controlledLiveRampMissingRuntimeSources.join(", ") || "none"}</span></div>
            <div className="row"><span>Degraded truth sources</span><span className={controlledLiveRampDegradedRuntimeSources.length > 0 ? "warn" : "good"}>{controlledLiveRampDegradedRuntimeSources.join(", ") || "none"}</span></div>
            {controlledLiveRampRuntimeSourceRows.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <div className="subtle mini" style={{ marginBottom: 6 }}>runtime_source_degradation_map</div>
                {controlledLiveRampRuntimeSourceRows.map((source, index) => {
                  const status = String(source.status || "unknown");
                  const detailStatus = String(source.detail_status || "").trim();
                  const sourceReasons = asStringArray(source.degradation_reasons);
                  const freshness = asRecord(source.freshness);
                  const sourceTone = status === "available" ? "good" : status === "skipped" ? "subtle" : "warn";
                  return (
                    <div key={`controlled-ramp-source-map-${String(source.name || "source")}-${index}`} className="row" style={{ marginTop: 4 }}>
                      <span>{String(source.name || "source")}{detailStatus ? ` · ${detailStatus}` : ""} · {sourceReasons.slice(0, 2).join(", ") || String(source.repair_hint || "ok")}</span>
                      <span className={sourceTone}>{status}{Boolean(source.blocking) ? " · block" : ""}{freshness.stale === true ? " · stale" : ""}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            <div className="row"><span>Replay certification</span><span className={controlledLiveRampReplayGate.available && controlledLiveRampReplayGate.ready === false ? "subtle" : "good"}>{controlledLiveRampReplayGate.available ? `${toNumber(controlledLiveRampReplayGate.certified_total, 0)} / ${toNumber(controlledLiveRampReplayGate.required_total, 0)}` : "unavailable"}</span></div>
            <div className="row"><span>Public probe</span><span className={String(controlledLiveRampPublicProbe.status || "") === "pass" ? "good" : String(controlledLiveRampPublicProbe.status || "") === "skipped" ? "subtle" : "warn"}>{String(controlledLiveRampPublicProbe.status || "unavailable")} · {String(controlledLiveRampPublicProbe.observed || controlledLiveRampPublicProbe.summary || "-")}</span></div>
            <div className="row"><span>Auth probe</span><span className={String(controlledLiveRampAuthProbe.status || "") === "pass" ? "good" : ["fail", "not_authorized", "schema_not_verified"].includes(String(controlledLiveRampAuthProbe.status || "")) ? "warn" : "subtle"}>{String(controlledLiveRampAuthProbe.status || "not_run")} · {String(controlledLiveRampAuthProbe.method || "unauthenticated")}</span></div>
            <div className="row"><span>Auth schema</span><span className={Boolean(controlledLiveRampAuthProbe.schema_verified) ? "good" : "warn"}>{Boolean(controlledLiveRampAuthProbe.schema_verified) ? "verified" : "not_verified"}</span></div>
            <div className="row"><span>Auth missing fields</span><span className={controlledLiveRampAuthMissingFields.length > 0 ? "warn" : "good"}>{controlledLiveRampAuthMissingFields.join(", ") || "none"}</span></div>
            <div className="row"><span>Bus health</span><span className={Boolean(controlledLiveRampBusHealth.verified) ? "good" : "warn"}>{String(controlledLiveRampBusHealth.status || "unknown")} · {String(controlledLiveRampBusHealth.repair_hint || "verified")}</span></div>
            <div className="row"><span>Bus observer</span><span className={String(controlledLiveRampBusHealth.source_context || "") === "docker_service_network" ? "good" : "warn"}>{String(controlledLiveRampBusHealth.observer || "unknown")} · {String(controlledLiveRampBusHealth.source_context || "unknown")} · {String(controlledLiveRampBusHealth.http_status || "-")} · {String(controlledLiveRampBusHealth.checked_url || "-")}</span></div>
            <div className="row"><span>Bus transport</span><span className={String(controlledLiveRampBusTransport.status || "") === "online" ? "good" : "warn"}>{String(controlledLiveRampBusTransport.status || "unknown")} · {String(controlledLiveRampBusTransport.kind || "unknown")} · {String(controlledLiveRampBusTransport.ping_ms ?? "-")}ms</span></div>
            <div className="row"><span>Live observation</span><span className={String(controlledLiveRampBusLiveObservation.status || "") === "online" ? "good" : "warn"}>{String(controlledLiveRampBusLiveObservation.status || "unknown")} · gate {String(controlledLiveRampBusLiveObservation.opportunity_gate_status || "unknown")} · seq {String(controlledLiveRampBusLiveObservation.bus_seq ?? "-")} · {String(controlledLiveRampBusLiveObservation.updated_at || "unknown")}</span></div>
            <div className="row"><span>Bus publisher</span><span className={String(controlledLiveRampBusPublisher.status || "") === "online" ? "good" : "warn"}>{String(controlledLiveRampBusPublisher.status || "unknown")} · {String(controlledLiveRampBusPublisher.stream || "unknown")} · {String(controlledLiveRampBusPublisher.last_heartbeat_at || "unknown")}</span></div>
            <div className="row"><span>Bus consumer</span><span className={["online", "not_required"].includes(String(controlledLiveRampBusConsumer.status || "")) ? "good" : "warn"}>{String(controlledLiveRampBusConsumer.status || "unknown")} · {String(controlledLiveRampBusConsumer.source || "unknown")} · {String(controlledLiveRampBusConsumer.last_read_at || "unknown")}</span></div>
            <div className="row"><span>Legacy watchdog</span><span className={controlledLiveRampLegacyWatchdog.blocks_reset === false ? "good" : "warn"}>{String(controlledLiveRampLegacyWatchdog.decision || "unknown")} · groups {String(controlledLiveRampLegacyWatchdog.redis_groups ?? "-")} · {String(controlledLiveRampLegacyWatchdog.consumer_mode || "unknown")}{asRecord(controlledLiveRampLegacyWatchdog.supersession).effective === true ? ` · by ${String(asRecord(controlledLiveRampLegacyWatchdog.supersession).superseded_by || "live_observation")}` : ""}</span></div>
            <div className="row"><span>Bus last event</span><span className={toNumber(controlledLiveRampBusHealth.event_lag_ms, 0) > 600000 ? "warn" : "subtle"}>{String(controlledLiveRampBusHealth.last_event_at || "unknown")}</span></div>
            <div className="row"><span>Kill switch</span><span className={controlledLiveRampKillSwitch.active ? "warn" : controlledLiveRampKillSwitch.active === false ? "good" : "subtle"}>{controlledLiveRampKillSwitch.active === true ? "active" : controlledLiveRampKillSwitch.active === false ? "inactive" : "unknown"} · reset {Boolean(controlledLiveRampKillSwitch.reset_eligible) ? "eligible" : "locked"}</span></div>
            <div className="row"><span>Kill switch reason</span><span className={controlledLiveRampKillSwitch.active ? "warn" : "subtle"}>{String(controlledLiveRampKillSwitch.reason || "none")}</span></div>
            <div className="row"><span>Kill switch transition</span><span>{String(controlledLiveRampKillSwitch.last_transition || "unknown")}</span></div>
            <div className="row"><span>Reset blockers</span><span className={controlledLiveRampKillSwitchResetBlockers.length > 0 ? "warn" : "good"}>{controlledLiveRampKillSwitchResetBlockers.join(", ") || "none"}</span></div>
            <div className="row"><span>Public health</span><span className={controlledLiveRampPublicHealth.healthy === false ? "warn" : controlledLiveRampPublicHealth.available ? "good" : "subtle"}>{String(controlledLiveRampPublicHealth.summary || "unavailable")}</span></div>
            <div className="subtle mini" style={{ marginTop: 6 }}>{String(controlledLiveRampCleanliness.summary || "cleanliness unavailable")}</div>
            {controlledLiveRampOpsUnavailableReasons.length > 0 || controlledLiveRampBlockReasons.length > 0 || controlledLiveRampYellowFlags.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                {[
                  ...controlledLiveRampOpsUnavailableReasons.map((reason) => ({ reason, tone: "warn", label: "ops unavailable" })),
                  ...controlledLiveRampBlockReasons.map((reason) => ({ reason, tone: "warn", label: "block" })),
                  ...controlledLiveRampYellowFlags.slice(0, 5).map((reason) => ({ reason, tone: "subtle", label: "flag" })),
                ].map((item, index) => (
                  <div key={`controlled-live-ramp-${item.label}-${index}`} className="row" style={{ marginTop: 4 }}>
                    <span>{item.reason}</span>
                    <span className={item.tone}>{item.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {terminalReviewRequiredItems.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>review_required.items</div>
              <div style={{ display: "grid", gap: 8 }}>
                {terminalReviewRequiredItems.map((item, index) => {
                  const decisionId = String(item.decision_id || "unknown").trim() || "unknown";
                  const candidateState = String(item.candidate_state || "unclassified").trim() || "unclassified";
                  const reason = String(item.reason || "no reason provided").trim() || "no reason provided";
                  const missingEvidence = asStringArray(item.missing_evidence);
                  return (
                    <div key={`review-required-${decisionId}-${index}`} style={{ border: "1px solid rgba(148, 163, 184, 0.16)", borderRadius: 12, padding: 10, background: "rgba(15, 23, 42, 0.22)" }}>
                      <div className="row"><span>{decisionId}</span><span className={Boolean(item.blocks_publish) ? "warn" : "subtle"}>{candidateState}</span></div>
                      <div className="subtle mini" style={{ marginTop: 4 }}>{reason}</div>
                      <div className="subtle mini" style={{ marginTop: 4 }}>missing_evidence: {missingEvidence.join(", ") || "none"} · blocks_publish: {Boolean(item.blocks_publish) ? "yes" : "no"}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {decisionContinuityLinks.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Journey completion by link</div>
              {decisionContinuityLinks.map((item, index) => (
                <div key={`${String(item.link_key || "unknown")}-${index}`} style={{ marginTop: 6 }}>
                  <div className="row">
                    <span>{String(item.label || "unknown")}</span>
                    <span className={toneClassForPct(toNumber(item.continuity_score_pct, 0))}>{toNumber(item.continuity_score_pct, 0).toFixed(1)}%</span>
                  </div>
                  <div className="subtle mini">N {toNumber(item.native, 0)} / B {toNumber(item.backfilled, 0)} / I {toNumber(item.inferred, 0)} / M {toNumber(item.missing, 0)}</div>
                </div>
              ))}
            </div>
          ) : null}
          {decisionGapReductionByStage.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>First Missing Stage</div>
              {decisionGapReductionByStage.map((stage, index) => (
                <div key={`${String(stage.stage_key || "gap")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(stage.gap_label || stage.label || "unknown")}</span>
                  <span className={toNumber(stage.blocked_decision_total, 0) > 0 ? "warn" : "good"}>{toNumber(stage.blocked_decision_total, 0)} · {toNumber(stage.share_pct, 0).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionGapReductionDominantStage && Array.isArray(decisionGapReductionDominantStage.exemplar_decisions) && decisionGapReductionDominantStage.exemplar_decisions.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Current dominant gap exemplars</div>
              {decisionGapReductionDominantStage.exemplar_decisions.map((item, index) => (
                <div key={`gap-current-exemplar-${String((item as Record<string, unknown>).decision_id || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String((item as Record<string, unknown>).decision_id || "unknown")}</span>
                  <span className="warn">fragments {toNumber((item as Record<string, unknown>).observed_fragments, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionGapReduction7dDominantStage && Array.isArray(decisionGapReduction7dDominantStage.exemplar_decisions) && decisionGapReduction7dDominantStage.exemplar_decisions.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>7j dominant gap exemplars</div>
              {decisionGapReduction7dDominantStage.exemplar_decisions.map((item, index) => (
                <div key={`gap-7d-exemplar-${String((item as Record<string, unknown>).decision_id || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String((item as Record<string, unknown>).decision_id || "unknown")}</span>
                  <span className="warn">seen {toNumber((item as Record<string, unknown>).occurrence_count, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionGapReduction30dDominantStage && Array.isArray(decisionGapReduction30dDominantStage.exemplar_decisions) && decisionGapReduction30dDominantStage.exemplar_decisions.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>30j dominant gap exemplars</div>
              {decisionGapReduction30dDominantStage.exemplar_decisions.map((item, index) => (
                <div key={`gap-30d-exemplar-${String((item as Record<string, unknown>).decision_id || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String((item as Record<string, unknown>).decision_id || "unknown")}</span>
                  <span className="warn">seen {toNumber((item as Record<string, unknown>).occurrence_count, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Evidence Conversion Engine</div>
          <div className="subtle" style={{ marginTop: 6 }}>Deuxieme campagne : convertir l evidence INFERRED en BACKFILLED puis en NATIVE, maillon par maillon.</div>
          <div className="row"><span>Evidence quality score</span><span className={toneClassForPct(decisionEvidenceQualityPct)}>{decisionEvidenceQualityPct.toFixed(1)}%</span></div>
          <div className="row"><span>NATIVE</span><span className="good">{toNumber(decisionEvidenceQuality.native, 0)}</span></div>
          <div className="row"><span>BACKFILLED</span><span>{toNumber(decisionEvidenceQuality.backfilled, 0)}</span></div>
          <div className="row"><span>INFERRED</span><span className="warn">{toNumber(decisionEvidenceQuality.inferred, 0)}</span></div>
          <div className="row"><span>MISSING</span><span className="warn">{toNumber(decisionEvidenceQuality.missing, 0)}</span></div>
          <div className="row"><span>Causality confidence</span><span>N {toNumber(lifecycleCausalityConfidence.native, 0)} / B {toNumber(lifecycleCausalityConfidence.backfilled, 0)} / I {toNumber(lifecycleCausalityConfidence.inferred, 0)}</span></div>
          <div style={{ marginTop: 10 }}>
            <div className="subtle mini" style={{ marginBottom: 6 }}>Evidence conversion pipeline</div>
            {evidencePipeline.map((step, index) => (
              <div key={`evidence-pipeline-${step.key}`} style={{ marginTop: index === 0 ? 0 : 8, borderRadius: 10, border: "1px solid rgba(148, 163, 184, 0.12)", padding: 8, background: "rgba(2, 6, 23, 0.16)" }}>
                <div className="row">
                  <span>{step.label}</span>
                  <span className={step.tone}>{step.value}</span>
                </div>
                <div className="subtle mini" style={{ marginTop: 4 }}>{step.next}</div>
              </div>
            ))}
          </div>
          {decisionEvidenceQualityByStage.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Evidence quality by stage</div>
              {decisionEvidenceQualityByStage.map((stage, index) => (
                <div key={`${String(stage.stage_key || "stage")}-${index}`} style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(148, 163, 184, 0.12)", padding: 8, background: "rgba(2, 6, 23, 0.16)" }}>
                  <div className="row">
                    <span>{String(stage.label || stage.stage_key || "unknown")}</span>
                    <span className={toneClassForPct(toNumber(stage.score_pct, 0))}>{toNumber(stage.score_pct, 0).toFixed(1)}%</span>
                  </div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>
                    N {toNumber(stage.native, 0)} / B {toNumber(stage.backfilled, 0)} / I {toNumber(stage.inferred, 0)} / M {toNumber(stage.missing, 0)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {lifecycleTopDecisionFriction.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Decision friction principaux</div>
              {lifecycleTopDecisionFriction.map((item, index) => (
                <div key={`${String(item.decision_id || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")} · {String(item.decision_id || "unknown").slice(0, 24)}</span>
                  <span className="warn">{toNumber(item.blocked_count, 0)}x</span>
                </div>
              ))}
            </div>
          ) : null}
          {lifecycleTopFrictionByGate.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Decision friction par gate</div>
              {lifecycleTopFrictionByGate.map((item, index) => (
                <div key={`${String(item.gate_name || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")}</span>
                  <span className="warn">{toNumber(item.blocked_count, 0)} · {toNumber(item.unique_decision_count, 0)} decisions</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Decision Gap Resolution System</div>
          <div className="subtle" style={{ marginTop: 6 }}>On ne suit plus seulement le gap dominant: on ouvre un dossier par decision, avec cause probable, remediation et temps jusqu a la continuite.</div>
          <div className="row"><span>Gap Resolution Rate</span><span className={toneClassForPct(gapResolutionRatePct)}>{gapResolutionRatePct.toFixed(1)}%</span></div>
          <div className="row"><span>Gap Resolution Rate 7j</span><span className={toneClassForPct(gapResolutionRate7dPct)}>{gapResolutionRate7dPct.toFixed(1)}%</span></div>
          <div className="row"><span>Gap Resolution Rate 30j</span><span className={toneClassForPct(gapResolutionRate30dPct)}>{gapResolutionRate30dPct.toFixed(1)}%</span></div>
          <div className="row"><span>Mean Time To Continuity</span><span className={meanTimeToContinuityHours !== null && meanTimeToContinuityHours <= 24 ? "good" : "warn"}>{meanTimeToContinuityHours !== null ? `${meanTimeToContinuityHours.toFixed(1)} h` : "-"}</span></div>
          <div className="row"><span>MTTC 7j</span><span className={meanTimeToContinuity7dHours !== null && meanTimeToContinuity7dHours <= 24 ? "good" : "warn"}>{meanTimeToContinuity7dHours !== null ? `${meanTimeToContinuity7dHours.toFixed(1)} h` : "-"}</span></div>
          <div className="row"><span>MTTC 30j</span><span className={meanTimeToContinuity30dHours !== null && meanTimeToContinuity30dHours <= 24 ? "good" : "warn"}>{meanTimeToContinuity30dHours !== null ? `${meanTimeToContinuity30dHours.toFixed(1)} h` : "-"}</span></div>
          <div className="row"><span>Open gaps</span><span className={toNumber(decisionGapResolution.open_gap_total, 0) > 0 ? "warn" : "good"}>{toNumber(decisionGapResolution.open_gap_total, 0)}</span></div>
          <div className="row"><span>Resolved gaps</span><span className={toNumber(decisionGapResolution.resolved_gap_total, 0) > 0 ? "good" : "subtle"}>{toNumber(decisionGapResolution.resolved_gap_total, 0)}</span></div>
          <div className="row"><span>Dominant open gap</span><span className={dominantOpenGapTotal > 0 ? "warn" : "good"}>{dominantOpenGapLabel}</span></div>
          <div className="row"><span>Dominant share</span><span className={dominantOpenGapSharePct > 0 ? "warn" : "good"}>{dominantOpenGapSharePct.toFixed(1)}%</span></div>
          {Object.keys(oldestOpenGap).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Oldest open gap</div>
              <div style={{ borderRadius: 10, border: "1px solid rgba(248, 113, 113, 0.18)", padding: 8, background: "rgba(127, 29, 29, 0.14)" }}>
                <div className="row">
                  <span>{String(oldestOpenGap.decision_id || "unknown")}</span>
                  <span className="warn">{Number.isFinite(Number(oldestOpenGap.open_age_hours)) ? `${toNumber(oldestOpenGap.open_age_hours, 0).toFixed(1)} h` : "-"}</span>
                </div>
                <div className="subtle mini" style={{ marginTop: 4 }}>{String(oldestOpenGap.gap_label || oldestOpenGap.first_missing_stage || "gap")}</div>
                <div className="subtle mini" style={{ marginTop: 4 }}>opened {formatDateTimeCompact(oldestOpenGap.opened_at_iso)}</div>
              </div>
            </div>
          ) : null}
          {backlogAgeBuckets.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gap backlog age</div>
              {backlogAgeBuckets.map((bucket, index) => (
                <div key={`gap-age-bucket-${String(bucket.bucket_key || index)}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(bucket.label || bucket.bucket_key || "bucket")}</span>
                  <span className={toNumber(bucket.open_gap_total, 0) > 0 ? "warn" : "good"}>{toNumber(bucket.open_gap_total, 0)} · {toNumber(bucket.share_pct, 0).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          ) : null}
          {backlogAgeBuckets7d.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gap backlog age 7j</div>
              {backlogAgeBuckets7d.map((bucket, index) => (
                <div key={`gap-age-bucket-7d-${String(bucket.bucket_key || index)}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(bucket.label || bucket.bucket_key || "bucket")}</span>
                  <span className={toNumber(bucket.latest_open_gap_total, 0) > 0 ? "warn" : "good"}>{toNumber(bucket.latest_open_gap_total, 0)} ({toNumber(bucket.open_gap_growth, 0) >= 0 ? "+" : ""}{toNumber(bucket.open_gap_growth, 0).toFixed(1)})</span>
                </div>
              ))}
            </div>
          ) : null}
          {backlogAgeBuckets30d.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gap backlog age 30j</div>
              {backlogAgeBuckets30d.map((bucket, index) => (
                <div key={`gap-age-bucket-30d-${String(bucket.bucket_key || index)}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(bucket.label || bucket.bucket_key || "bucket")}</span>
                  <span className={toNumber(bucket.latest_open_gap_total, 0) > 0 ? "warn" : "good"}>{toNumber(bucket.latest_open_gap_total, 0)} ({toNumber(bucket.open_gap_growth, 0) >= 0 ? "+" : ""}{toNumber(bucket.open_gap_growth, 0).toFixed(1)})</span>
                </div>
              ))}
            </div>
          ) : null}
          {Object.keys(dominantGapCardinality).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gap cardinality</div>
              <div className="row"><span>Occurrences</span><span className="warn">{toNumber(dominantGapCardinality.gap_occurrence_total, 0)}</span></div>
              <div className="row"><span>Decision IDs uniques</span><span>{toNumber(dominantGapCardinality.unique_decision_total, 0)}</span></div>
              <div className="row"><span>Lifecycle IDs uniques</span><span>{toNumber(dominantGapCardinality.unique_trade_lifecycle_total, 0)}</span></div>
              <div className="row"><span>Root causes uniques</span><span>{toNumber(dominantGapCardinality.unique_root_cause_total, 0)}</span></div>
              {dominantGapRootCauses.length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  <div className="subtle mini" style={{ marginBottom: 6 }}>Root causes dominantes</div>
                  {dominantGapRootCauses.map((cause, index) => (
                    <div key={`gap-root-cause-${String(cause.root_cause_code || index)}`} className="row" style={{ marginTop: 4 }}>
                      <span>{String(cause.label || cause.root_cause_code || "unknown")}</span>
                      <span className="warn">{toNumber(cause.open_gap_total, 0)} · {toNumber(cause.share_pct, 0).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {Object.keys(dominantGapCardinality7d).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gap cardinality 7j</div>
              <div className="row"><span>Occurrences avg</span><span>{toNumber(asRecord(dominantGapCardinality7d.gap_occurrence_total).avg, 0).toFixed(1)}</span></div>
              <div className="row"><span>Decision IDs avg</span><span>{toNumber(asRecord(dominantGapCardinality7d.unique_decision_total).avg, 0).toFixed(1)}</span></div>
              <div className="row"><span>Root causes avg</span><span>{toNumber(asRecord(dominantGapCardinality7d.unique_root_cause_total).avg, 0).toFixed(1)}</span></div>
            </div>
          ) : null}
          {Object.keys(dominantGapCardinality30d).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gap cardinality 30j</div>
              <div className="row"><span>Occurrences avg</span><span>{toNumber(asRecord(dominantGapCardinality30d.gap_occurrence_total).avg, 0).toFixed(1)}</span></div>
              <div className="row"><span>Decision IDs avg</span><span>{toNumber(asRecord(dominantGapCardinality30d.unique_decision_total).avg, 0).toFixed(1)}</span></div>
              <div className="row"><span>Root causes avg</span><span>{toNumber(asRecord(dominantGapCardinality30d.unique_root_cause_total).avg, 0).toFixed(1)}</span></div>
            </div>
          ) : null}
          {dominantGapTopDecisions.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Top 10 decision_id du gap dominant</div>
              {dominantGapTopDecisions.map((item, index) => (
                <div key={`gap-resolution-dominant-${String(item.gap_id || item.decision_id || "unknown")}-${index}`} style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(248, 113, 113, 0.18)", padding: 8, background: "rgba(127, 29, 29, 0.14)" }}>
                  <div className="row">
                    <span>{String(item.decision_id || "unknown")}</span>
                    <span className="warn">fragments {toNumber(item.observed_fragments, 0)}</span>
                  </div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>{String(item.gap_label || dominantOpenGapLabel || "Gap")}</div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>opened {formatDateTimeCompact(item.opened_at_iso)} · age {Number.isFinite(Number(item.open_age_hours)) ? `${toNumber(item.open_age_hours, 0).toFixed(1)} h` : "-"}</div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>why {String(item.root_cause || "unknown")}</div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>fix {String(item.remediation || "unknown")}</div>
                </div>
              ))}
            </div>
          ) : null}
          {resolvedGapLedgerRows.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Recently resolved gaps</div>
              {resolvedGapLedgerRows.map((item, index) => (
                <div key={`gap-resolution-resolved-${String(item.gap_id || item.decision_id || "resolved")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.decision_id || "unknown")} · {String(item.gap_label || "resolved")}</span>
                  <span className="good">{Number.isFinite(Number(item.resolution_time_hours)) ? `${toNumber(item.resolution_time_hours, 0).toFixed(1)} h` : "resolved"}</span>
                </div>
              ))}
            </div>
          ) : null}
          {openGapLedgerRows.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Open gap ledger</div>
              {openGapLedgerRows.map((item, index) => (
                <div key={`gap-ledger-open-${String(item.gap_id || item.decision_id || "open")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.decision_id || "unknown")} · {String(item.gap_label || item.first_missing_stage || "gap")}</span>
                  <span className="warn">{formatDateTimeCompact(item.opened_at_iso)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {allocationWriterAuditActive ? (
          <div className="panel">
            <div className="eyebrow">Allocation Writer Closure Program</div>
            <div className="subtle" style={{ marginTop: 6 }}>Programme unique de suppression de la cause dominante. Le but n est plus de mesurer des symptomes, mais de prouver qu une correction elimine effectivement le gap et fait disparaitre la cause.</div>
            <div className="row"><span>Allocation Closure Rate</span><span className={allocationClosureRateTone}>{allocationClosureRatePct.toFixed(1)}%</span></div>
            <div className="row"><span>Dominant root cause</span><span className="warn">{String(allocationWriterClosure.dominant_root_cause_label || currentAllocationWriterCause?.label || dominantGapTopDecisions[0]?.root_cause || allocationWriterRootCauseCode)}</span></div>
            <div className="row"><span>Root cause concentration</span><span className="warn">{rootCauseConcentrationPct.toFixed(1)}%</span></div>
            <div className="row"><span>Current occurrences</span><span className="warn">{toNumber(currentAllocationWriterCause?.open_gap_total, 0)}</span></div>
            <div className="row"><span>Current oldest open gap</span><span className="warn">{Number.isFinite(Number(oldestOpenGap.open_age_hours)) ? `${toNumber(oldestOpenGap.open_age_hours, 0).toFixed(1)} h` : "-"}</span></div>
            <div className="row"><span>Root Cause Closure Rate</span><span className={rootCauseClosureRateTone}>{rootCauseClosureRatePct.toFixed(1)}%</span></div>
            <div className="row"><span>Gap Closure Rate</span><span className={toneClassForPct(toNumber(allocationWriterClosureEvidence.gap_closure_rate_pct, 0))}>{toNumber(allocationWriterClosureEvidence.gap_closure_rate_pct, 0).toFixed(1)}%</span></div>
            <div className="row"><span>Native Closure Rate</span><span className={toneClassForPct(toNumber(allocationWriterClosureEvidence.native_closure_rate_pct, 0))}>{toNumber(allocationWriterClosureEvidence.native_closure_rate_pct, 0).toFixed(1)}%</span></div>
            <div className="row"><span>Top cause</span><span className="warn">{String(allocationWriterClosureEvidence.top_cause_label || allocationWriterClosureEvidence.top_cause_key || "none")}</span></div>
            <div className="subtle mini" style={{ marginTop: 6 }}>Top fix {String(allocationWriterClosureEvidence.top_fix || "closure evidence not instrumented yet")}</div>
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Audit 1 · Canonical State Machine</div>
              <div className="row"><span>allocation_created_total</span><span>{toNumber(allocationWriterStateMachine.allocation_created_total, 0)}</span></div>
              <div className="row"><span>allocation_closed_total</span><span className={allocationClosureRateTone}>{toNumber(allocationWriterStateMachine.allocation_closed_total, 0)}</span></div>
              <div className="row"><span>allocation_open_total</span><span className={toNumber(allocationWriterStateMachine.allocation_open_total, 0) > 0 ? "warn" : "good"}>{toNumber(allocationWriterStateMachine.allocation_open_total, 0)}</span></div>
              <div className="row"><span>approval_created_total</span><span>{toNumber(allocationWriterStateMachine.approval_created_total, 0)}</span></div>
              <div className="row"><span>approval_linked_total</span><span>{toNumber(allocationWriterStateMachine.approval_linked_total, 0)}</span></div>
              <div className="row"><span>hardening_reached_total</span><span>{toNumber(allocationWriterStateMachine.hardening_reached_total, 0)}</span></div>
              <div className="row"><span>execution_created_total</span><span>{toNumber(allocationWriterStateMachine.execution_created_total, 0)}</span></div>
              <div className="row"><span>outcome_created_total</span><span>{toNumber(allocationWriterStateMachine.outcome_created_total, 0)}</span></div>
              <div className="row"><span>attribution_created_total</span><span>{toNumber(allocationWriterStateMachine.attribution_created_total, 0)}</span></div>
              <div className="row"><span>opportunity_created_total</span><span>{toNumber(allocationWriterStateMachine.opportunity_created_total, 0)}</span></div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Audit 2 · Writer Native Writes</div>
              <div className="row"><span>allocation_created_total</span><span>{toNumber(allocationWriterCoverage.allocation_created_total, Number.NaN).toString() === "NaN" ? "-" : toNumber(allocationWriterCoverage.allocation_created_total, 0)}</span></div>
              <div className="row"><span>allocation_persisted_total</span><span>{toNumber(allocationWriterCoverage.allocation_persisted_total, Number.NaN).toString() === "NaN" ? "-" : toNumber(allocationWriterCoverage.allocation_persisted_total, 0)}</span></div>
              <div className="row"><span>allocation_failed_total</span><span className={toNumber(allocationWriterCoverage.allocation_failed_total, 0) > 0 ? "warn" : "good"}>{toNumber(allocationWriterCoverage.allocation_failed_total, Number.NaN).toString() === "NaN" ? "-" : toNumber(allocationWriterCoverage.allocation_failed_total, 0)}</span></div>
              <div className="row"><span>allocation_written_total</span><span>{toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
              <div className="row"><span>allocation_write_rate_pct</span><span>{Number.isFinite(Number(allocationWriterCoverage.allocation_write_rate_pct)) ? `${toNumber(allocationWriterCoverage.allocation_write_rate_pct, 0).toFixed(1)}%` : "-"}</span></div>
              {!Boolean(allocationWriterCoverage.created_signal_instrumented) ? (
                <div className="subtle mini" style={{ marginTop: 4 }}>Le vrai created_total amont n est pas encore instrumente dans le writer; la couverture affiche donc la qualite des writes observes, pas le write rate source.</div>
              ) : null}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Audit 3 · Identity Propagation</div>
              <div className="row"><span>identity_propagation_rate</span><span className={toneClassForPct(toNumber(allocationWriterIdentityPropagation.identity_propagation_rate_pct, 0))}>{toNumber(allocationWriterIdentityPropagation.identity_propagation_rate_pct, 0).toFixed(1)}%</span></div>
              <div className="row"><span>decision_id</span><span>{toNumber(allocationWriterIdentityPropagation.decision_id_total, 0)} / {toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
              <div className="row"><span>candidate_id</span><span>{toNumber(allocationWriterIdentityPropagation.candidate_id_total, 0)} / {toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
              <div className="row"><span>trade_lifecycle_id</span><span>{toNumber(allocationWriterIdentityPropagation.trade_lifecycle_id_total, 0)} / {toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
              <div className="row"><span>approval_id</span><span>{toNumber(allocationWriterIdentityPropagation.approval_id_total, 0)} / {toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
              <div className="row"><span>execution_id</span><span>{toNumber(allocationWriterIdentityPropagation.execution_id_total, 0)} / {toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
              <div className="row"><span>outcome_id</span><span>{toNumber(allocationWriterIdentityPropagation.outcome_id_total, 0)} / {toNumber(allocationWriterCoverage.allocation_written_total, 0)}</span></div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Audit 4 · Dominant Gap Split</div>
              {allocationWriterFailureCategories.map((category, index) => (
                <div key={`allocation-writer-taxonomy-${String(category.category_key || index)}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(category.label || category.category_key || "unknown")}</span>
                  <span className={toNumber(category.total, 0) > 0 ? "warn" : "subtle"}>{toNumber(category.total, 0)} · {toNumber(category.share_pct, 0).toFixed(1)}%</span>
                </div>
              ))}
              {allocationWriterFailureCategories.length === 0 ? (
                <div className="subtle mini" style={{ marginTop: 4 }}>Aucune cause ouverte detaillee observee sur la fenetre courante.</div>
              ) : null}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Audit 5 · Writer Native Errors</div>
              {allocationWriterNativeErrors.map((entry, index) => (
                <div key={`allocation-writer-native-error-${String(entry.error_code || index)}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(entry.label || entry.error_code || "unknown")}</span>
                  <span className={toNumber(entry.total, 0) > 0 ? "warn" : "subtle"}>{toNumber(entry.total, 0)} · {toNumber(entry.share_pct, 0).toFixed(1)}%</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Latency to first downstream fact</div>
              <div className="row"><span>Measured allocations</span><span>{toNumber(allocationWriterLatency.measured_allocation_total, 0)}</span></div>
              <div className="row"><span>P50</span><span className={Number.isFinite(Number(allocationWriterLatency.p50_hours)) && toNumber(allocationWriterLatency.p50_hours, 0) <= 24 ? "good" : "warn"}>{Number.isFinite(Number(allocationWriterLatency.p50_hours)) ? `${toNumber(allocationWriterLatency.p50_hours, 0).toFixed(1)} h` : "-"}</span></div>
              <div className="row"><span>P95</span><span className={Number.isFinite(Number(allocationWriterLatency.p95_hours)) && toNumber(allocationWriterLatency.p95_hours, 0) <= 24 ? "good" : "warn"}>{Number.isFinite(Number(allocationWriterLatency.p95_hours)) ? `${toNumber(allocationWriterLatency.p95_hours, 0).toFixed(1)} h` : "-"}</span></div>
              <div className="row"><span>P99</span><span className={Number.isFinite(Number(allocationWriterLatency.p99_hours)) && toNumber(allocationWriterLatency.p99_hours, 0) <= 24 ? "good" : "warn"}>{Number.isFinite(Number(allocationWriterLatency.p99_hours)) ? `${toNumber(allocationWriterLatency.p99_hours, 0).toFixed(1)} h` : "-"}</span></div>
              <div className="row"><span>allocation_to_approval_rate</span><span className={toneClassForPct(toNumber(allocationWriterPropagation.allocation_to_approval_rate_pct, 0))}>{toNumber(allocationWriterPropagation.allocation_to_approval_rate_pct, 0).toFixed(1)}%</span></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}><span>Root causes corrected / identified</span><span>{toNumber(allocationWriterClosureEvidence.corrected_root_cause_total, 0)} / {toNumber(allocationWriterClosureEvidence.identified_root_cause_total, 0)}</span></div>
            <div className="row"><span>Gaps closed / open+closed</span><span>{toNumber(allocationWriterClosureEvidence.closed_gap_total, 0)} / {toNumber(allocationWriterClosureEvidence.open_gap_total, 0) + toNumber(allocationWriterClosureEvidence.closed_gap_total, 0)}</span></div>
            <div className="row"><span>Native failed then closed</span><span>{toNumber(allocationWriterClosureEvidence.native_closed_allocation_total, 0)} / {toNumber(allocationWriterClosureEvidence.native_failed_allocation_total, 0)}</span></div>
            {allocationWriterProvenance.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div className="subtle mini" style={{ marginBottom: 6 }}>Writer Provenance</div>
                {allocationWriterProvenance.slice(0, 8).map((entry, index) => (
                  <div key={`allocation-writer-provenance-${String(entry.allocation_id || index)}`} style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(148, 163, 184, 0.12)", padding: 8, background: "rgba(2, 6, 23, 0.16)" }}>
                    <div className="row">
                      <span>{String(entry.allocation_id || "unknown")}</span>
                      <span className={String(entry.writer_result || "unknown") === "ok" ? "good" : "warn"}>{String(entry.writer_result || "unknown")}</span>
                    </div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>decision {String(entry.decision_id || "-")} · writer {String(entry.writer_version || "unknown")}</div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>timestamp {formatDateTimeCompact(entry.writer_timestamp)}</div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>first downstream {String(entry.first_downstream_stage || "none")} · first failure {String(entry.first_failure_stage || "none")}</div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>failure reason {String(entry.failure_reason || "none")}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="row" style={{ marginTop: 12 }}><span>7j dominant root cause</span><span className={String(dominantGapCardinality7d.dominant_root_cause_code_latest || "").trim() === allocationWriterRootCauseCode ? "warn" : "subtle"}>{String(dominantGapCardinality7d.dominant_root_cause_label_latest || "none")}</span></div>
            <div className="row"><span>7j concentration avg</span><span className={rootCauseConcentration7dPct >= 80 ? "warn" : rootCauseConcentration7dPct >= 40 ? "subtle" : "good"}>{rootCauseConcentration7dPct.toFixed(1)}%</span></div>
            <div className="row"><span>30j dominant root cause</span><span className={String(dominantGapCardinality30d.dominant_root_cause_code_latest || "").trim() === allocationWriterRootCauseCode ? "warn" : "subtle"}>{String(dominantGapCardinality30d.dominant_root_cause_label_latest || "none")}</span></div>
            <div className="row"><span>30j concentration avg</span><span className={rootCauseConcentration30dPct >= 80 ? "warn" : rootCauseConcentration30dPct >= 40 ? "subtle" : "good"}>{rootCauseConcentration30dPct.toFixed(1)}%</span></div>
            {dominantGapTopDecisions.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div className="subtle mini" style={{ marginBottom: 6 }}>Allocation writer exemplar decisions</div>
                {dominantGapTopDecisions.slice(0, 5).map((item, index) => (
                  <div key={`allocation-writer-audit-${String(item.gap_id || item.decision_id || index)}`} style={{ marginTop: 8, borderRadius: 10, border: "1px solid rgba(248, 113, 113, 0.18)", padding: 8, background: "rgba(127, 29, 29, 0.14)" }}>
                    <div className="row">
                      <span>{String(item.decision_id || "unknown")}</span>
                      <span className="warn">fragments {toNumber(item.observed_fragments, 0)}</span>
                    </div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>opened {formatDateTimeCompact(item.opened_at_iso)} · age {Number.isFinite(Number(item.open_age_hours)) ? `${toNumber(item.open_age_hours, 0).toFixed(1)} h` : "-"}</div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>audit {String(item.root_cause || "unknown")}</div>
                    <div className="subtle mini" style={{ marginTop: 4 }}>writer remediation {String(item.remediation || "unknown")}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Hardening Analytics 30D</div>
          <div className="row"><span>Approval #2 observed</span><span>{hardeningApprovalStage2Total}</span></div>
          <div className="row"><span>Hardening refused</span><span className="warn">{hardeningRefusedTotal}</span></div>
          <div className="row"><span>Unique decisions</span><span>{hardeningUniqueDecisionTotal}</span></div>
          {hardeningTopRefusalCauses.length > 0 || hardeningTopCostCauses.length > 0 || hardeningTopMissedAlphaCauses.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              {hardeningTopRefusalCauses.length > 0 ? (
                <div style={{ marginTop: 10 }}>
                  <div className="subtle mini" style={{ marginBottom: 6 }}>Top 10 causes de refus</div>
                  {hardeningTopRefusalCauses.map((item, index) => (
                    <div key={`hardening-refusal-${String(item.cause_key || "unknown")}-${index}`} style={{ marginTop: 6 }}>
                      <div className="row">
                        <span>{String(item.label || item.cause_key || "unknown")}</span>
                        <span className="warn">{toNumber(item.count, 0)} · {toNumber(item.share_pct, 0).toFixed(1)}%</span>
                      </div>
                      <div className="subtle mini">decisions {toNumber(item.decision_count, 0)} · opp {toNumber(item.opportunity_cost_bps, 0).toFixed(1)}bps · missed {toNumber(item.missed_alpha_bps, 0).toFixed(1)}bps</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {hardeningTopCostCauses.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <div className="subtle mini" style={{ marginBottom: 6 }}>Top 10 causes de cout</div>
                  {hardeningTopCostCauses.map((item, index) => (
                    <div key={`hardening-cost-${String(item.cause_key || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                      <span>{String(item.label || item.cause_key || "unknown")}</span>
                      <span className="warn">opp {toNumber(item.opportunity_cost_bps, 0).toFixed(1)}bps · {toNumber(item.count, 0)} refus</span>
                    </div>
                  ))}
                </div>
              ) : null}
              {hardeningTopMissedAlphaCauses.length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <div className="subtle mini" style={{ marginBottom: 6 }}>Top 10 causes d'alpha manque</div>
                  {hardeningTopMissedAlphaCauses.map((item, index) => (
                    <div key={`hardening-alpha-${String(item.cause_key || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                      <span>{String(item.label || item.cause_key || "unknown")}</span>
                      <span className="warn">missed {toNumber(item.missed_alpha_bps, 0).toFixed(1)}bps · {toNumber(item.count, 0)} refus</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="subtle mini" style={{ marginTop: 10 }}>Aucun refus hardening 30j materialise dans le snapshot local.</div>
          )}
        </div>
        <div className="panel">
          <div className="eyebrow">Decision Friction Analytics</div>
          <div className="row"><span>Blocked opportunities</span><span>{decisionFrictionBlockedTotal}</span></div>
          <div className="row"><span>Unique decisions</span><span>{decisionFrictionUniqueDecisionTotal}</span></div>
          <div className="row"><span>Repeated decisions</span><span className="warn">{decisionFrictionRepeatedDecisionTotal}</span></div>
          <div className="row"><span>Repeated blocked total</span><span className="warn">{decisionFrictionRepeatedBlockedTotal}</span></div>
          <div className="row"><span>Repeated blocked share</span><span className="warn">{decisionFrictionRepeatedBlockedSharePct.toFixed(1)}%</span></div>
          <div className="row"><span>Opportunity cost total</span><span className="warn">{decisionFrictionOpportunityCostBpsTotal.toFixed(1)}bps</span></div>
          <div className="row"><span>Missed alpha total</span><span className="warn">{decisionFrictionMissedAlphaBpsTotal.toFixed(1)}bps</span></div>
          <div className="row"><span>Capital impact total</span><span className="warn">{formatUsd(decisionFrictionCapitalImpactUsdTotal)}</span></div>
          <div className="row"><span>Capital impact / decision</span><span className="warn">{formatUsd(decisionFrictionCapitalImpactPerDecision)}</span></div>
          <div className="row"><span>Capital impact coverage</span><span className="warn">{decisionFrictionCapitalImpactCoveragePct.toFixed(1)}% · {decisionFrictionCapitalBasisAvailableRows} / {decisionFrictionCapitalBasisRowTotal} rows</span></div>
          <div className="row"><span>Dominant gate</span><span className="warn">{decisionFrictionDominantGateName} · {decisionFrictionDominantGateBlockedTotal} · {decisionFrictionDominantGateSharePct.toFixed(1)}%</span></div>
          <div className="row"><span>Dominant cost gate</span><span className="warn">{decisionFrictionDominantCostGateName} · {formatUsd(decisionFrictionDominantCostGateCapitalImpactUsd)}</span></div>
          <div className="row"><span>Dominant decision</span><span className="warn">{decisionFrictionDominantDecisionGateName} · {decisionFrictionDominantDecisionId.slice(0, 24)} · {decisionFrictionDominantDecisionBlockedTotal} · {decisionFrictionDominantDecisionSharePct.toFixed(1)}%</span></div>
          <div className="row"><span>Dominant cost decision</span><span className="warn">{decisionFrictionDominantCostDecisionGateName} · {decisionFrictionDominantCostDecisionId.slice(0, 24)} · {formatUsd(decisionFrictionDominantCostDecisionCapitalImpactUsd)} · opp {decisionFrictionDominantCostDecisionOpportunityCostBps.toFixed(1)}bps · missed {decisionFrictionDominantCostDecisionMissedAlphaBps.toFixed(1)}bps</span></div>
          {decisionFrictionWatchlistGates.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Watchlist codes</div>
              {decisionFrictionWatchlistGates.map((item, index) => (
                <div key={`${String(item.gate_name || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")}</span>
                  <span className="warn">{toNumber(item.blocked_total, 0)} · {toNumber(item.unique_decision_total, 0)} decisions · {toNumber(item.blocked_share_pct, 0).toFixed(1)}%</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionFrictionTopDecisions.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Top repeated decisions</div>
              {decisionFrictionTopDecisions.map((item, index) => (
                <div key={`decision-friction-${String(item.decision_id || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")} · {String(item.decision_id || "unknown").slice(0, 24)}</span>
                  <span className="warn">{toNumber(item.blocked_count, 0)}x · corr {toNumber(item.unique_correlation_keys, 0)} · {formatUsd(toNumber(item.capital_impact_usd_total, 0))} · opp {toNumber(item.opportunity_cost_bps_total, 0).toFixed(1)}bps</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionFrictionTopCostDecisions.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Top costly decisions</div>
              {decisionFrictionTopCostDecisions.map((item, index) => (
                <div key={`decision-friction-cost-${String(item.decision_id || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")} · {String(item.decision_id || "unknown").slice(0, 24)}</span>
                  <span className="warn">{formatUsd(toNumber(item.capital_impact_usd_total, 0))} · opp {toNumber(item.opportunity_cost_bps_total, 0).toFixed(1)}bps · missed {toNumber(item.missed_alpha_bps_total, 0).toFixed(1)}bps</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionFrictionTopGates.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Top friction gates</div>
              {decisionFrictionTopGates.map((item, index) => (
                <div key={`decision-friction-gate-${String(item.gate_name || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")}</span>
                  <span className="warn">{toNumber(item.blocked_count, 0)} · {toNumber(item.unique_decision_count, 0)} decisions · {toNumber(item.repeated_decision_count, 0)} repeats · {formatUsd(toNumber(item.capital_impact_usd_total, 0))} · /dec {formatUsd(toNumber(item.capital_impact_per_decision, 0))} · opp {toNumber(item.opportunity_cost_bps_total, 0).toFixed(1)}bps</span>
                </div>
              ))}
            </div>
          ) : null}
          {decisionFrictionTopCostGates.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Top costly gates</div>
              {decisionFrictionTopCostGates.map((item, index) => (
                <div key={`decision-friction-gate-cost-${String(item.gate_name || "unknown")}-${index}`} className="row" style={{ marginTop: 4 }}>
                  <span>{String(item.gate_name || "unknown")}</span>
                  <span className="warn">{formatUsd(toNumber(item.capital_impact_usd_total, 0))} · /dec {formatUsd(toNumber(item.capital_impact_per_decision, 0))} · missed {toNumber(item.missed_alpha_bps_total, 0).toFixed(1)}bps · opp {toNumber(item.opportunity_cost_bps_total, 0).toFixed(1)}bps</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel">
          <div className="eyebrow">Decision Governance Operating System</div>
          <div className="subtle" style={{ marginTop: 6 }}>La completion journey pilote la roadmap. Le TRI n est plus qu un derive de la preuve, pas son substitut.</div>
          <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 12, background: "rgba(15, 23, 42, 0.22)" }}>
            <div className="row"><span>Rule active</span><span className={decisionContinuityGovernanceRule.tone}>{decisionContinuityGovernanceRule.label}</span></div>
            <div className="row"><span>Action now</span><span className={decisionContinuityGovernanceRule.tone}>{decisionContinuityGovernanceRule.action}</span></div>
            <div className="row"><span>Objective</span><span>{decisionContinuityGovernanceRule.objective}</span></div>
            <div className="row"><span>Current completion</span><span className={toneClassForPct(journeyCompletionRatePct)}>{journeyCompletionRatePct.toFixed(1)}%</span></div>
            <div className="row"><span>Complete / created</span><span>{completeDecisionTotal} / {createdDecisionTotal}</span></div>
            <div className="row"><span>Alpha V2 gate</span><span className={journeyCompletionRatePct < 10 ? "warn" : "good"}>{journeyCompletionRatePct < 10 ? "locked until >= 10%" : "eligible by journey threshold"}</span></div>
            <div className="row"><span>Current evidence</span><span className={toneClassForPct(decisionEvidenceQualityPct)}>{decisionEvidenceQualityPct.toFixed(1)}%</span></div>
            <div className="row"><span>Downstream TRI</span><span className={toneClassForPct(truthReliabilityScorePct)}>{truthReliabilityScorePct.toFixed(1)}% · {truthReliabilityStatus}</span></div>
            <div className="row"><span>7j continuity avg</span><span>{truthReliability7dContinuityAvgPct.toFixed(1)}% · evidence {truthReliability7dEvidenceAvgPct.toFixed(1)}%</span></div>
            <div className="row"><span>30j continuity avg</span><span>{truthReliability30dContinuityAvgPct.toFixed(1)}% · evidence {truthReliability30dEvidenceAvgPct.toFixed(1)}%</span></div>
            <div className="row"><span>TRI trend</span><span>{truthReliability7dLatestPct.toFixed(1)}% / {truthReliability30dLatestPct.toFixed(1)}% · growth {truthReliability30dGrowthPct >= 0 ? "+" : ""}{truthReliability30dGrowthPct.toFixed(1)} pts</span></div>
          </div>
          <div style={{ marginTop: 10 }}>
            {DECISION_CONTINUITY_RULES.map((rule) => {
              const active = journeyCompletionRatePct >= rule.minInclusive && journeyCompletionRatePct < rule.maxExclusive;
              return (
                <div key={rule.label} className="row" style={{ marginTop: 4 }}>
                  <span>{rule.label}</span>
                  <span className={active ? rule.tone : "subtle"}>{active ? rule.action : rule.objective}</span>
                </div>
              );
            })}
          </div>
          {Object.keys(truthReliability30dStatusCounts).length > 0 ? (
            <div className="subtle mini" style={{ marginTop: 10 }}>
              30j TRI status mix: {Object.entries(truthReliability30dStatusCounts).map(([status, count]) => `${status} ${toNumber(count, 0).toFixed(0)}`).join(" · ")}
            </div>
          ) : null}
          <div className="subtle mini" style={{ marginTop: 6 }}>
            TRI guard actif: {truthReliabilityGovernanceRule.label} · {truthReliabilityGovernanceRule.action.toLowerCase()}
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel" data-testid="decision-trace-explorer-panel">
          <div className="eyebrow">Decision Trace Explorer</div>
          <div className="subtle" style={{ marginTop: 6 }}>Contrat operateur: expliquer n importe quel `decision_id` en moins de 10 secondes, avec timeline causale complete et maillons manquants visibles.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            {decisionTraceCandidateIds.length > 0 ? decisionTraceCandidateIds.map((decisionId) => (
              <button
                key={decisionId}
                type="button"
                className={selectedDecisionTraceId === decisionId ? "btn btn-primary" : "btn"}
                onClick={() => { setSelectedDecisionTraceId(decisionId); setDecisionTraceQueryInput(decisionId); }}
              >
                {decisionId.slice(0, 28)}
              </button>
            )) : (
              <div className="subtle mini">Aucun decision_id dominant disponible dans le snapshot courant.</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <input
              type="text"
              value={decisionTraceQueryInput}
              onChange={(event) => { setDecisionTraceQueryInput(event.target.value); }}
              placeholder="decision_id a expliquer"
              style={{ minWidth: 320, flex: "1 1 320px" }}
            />
            <button
              type="button"
              disabled={decisionTraceBusy || !decisionTraceQueryInput.trim()}
              onClick={() => {
                const nextDecisionId = decisionTraceQueryInput.trim();
                if (!nextDecisionId) {
                  return;
                }
                setSelectedDecisionTraceId(nextDecisionId);
              }}
            >
              Expliquer ce decision_id
            </button>
          </div>
          {decisionTraceError ? <p className="warn" style={{ marginTop: 10 }}>{decisionTraceError}</p> : null}
          {decisionTraceBusy ? <p className="subtle" style={{ marginTop: 10 }}>Chargement du trace causal...</p> : null}
          {!decisionTraceBusy && decisionTracePayload ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 12 }}>
                <div style={{ borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 10, background: "rgba(15, 23, 42, 0.22)" }}>
                  <div className="subtle mini">Summary</div>
                  <div className="row" style={{ marginTop: 6 }}><span>Status</span><span className={traceStatusClass(decisionTraceSummary.status)}>{String(decisionTraceSummary.status || "unknown")}</span></div>
                  <div className="row"><span>Decision</span><span>{String(decisionTraceSummary.decision_id || "-")}</span></div>
                  <div className="row"><span>Approval</span><span>{String(decisionTrace.approval_id || "-")}</span></div>
                  <div className="row"><span>Lifecycle</span><span>{String(decisionTraceSummary.trade_lifecycle_id || "-")}</span></div>
                  <div className="row"><span>Symbol</span><span>{String(decisionTraceSummary.symbol || "-")} · {String(decisionTraceSummary.side || "-")}</span></div>
                  <div className="row"><span>Blocking</span><span className={decisionTraceSummary.blocking_reason ? "warn" : "good"}>{String(decisionTraceSummary.blocking_reason || "none")}</span></div>
                </div>
                <div style={{ borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 10, background: "rgba(15, 23, 42, 0.22)" }}>
                  <div className="subtle mini">Operators</div>
                  <div className="row" style={{ marginTop: 6 }}><span>Approval #1</span><span>{String(decisionTraceSummary.first_approved_by || "-")}</span></div>
                  <div className="row"><span>Approval #2</span><span>{String(decisionTraceSummary.second_approved_by || "-")}</span></div>
                  <div className="row"><span>Projected facts</span><span>{decisionTraceFacts.length}</span></div>
                  <div className="row"><span>Oracle</span><span>{Object.keys(decisionTraceOracle).length > 0 ? String(decisionTraceOracle.status || decisionTraceOracle.reason || "present") : "n/a"}</span></div>
                  <div className="subtle mini" style={{ marginTop: 8 }}>
                    {Object.keys(decisionTraceOracle).length > 0
                      ? `${String(decisionTraceOracle.source || "oracle")} · age ${toNumber(decisionTraceOracle.age_ms, 0).toFixed(0)} ms · confidence ${toNumber(decisionTraceOracle.confidence, 0).toFixed(1)}`
                      : "Projection oracle indisponible pour cette trace."}
                  </div>
                </div>
                <div style={{ borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 10, background: decisionTraceError ? "rgba(127, 29, 29, 0.18)" : "rgba(15, 23, 42, 0.22)" }}>
                  <div className="subtle mini">Diagnostics lite</div>
                  <div className="row" style={{ marginTop: 6 }}><span>Mode</span><span>{decisionTraceMode}</span></div>
                  <div className="row"><span>Resolution</span><span className={decisionTraceResolvedVia.includes("synthetic") ? "warn" : "subtle"}>{decisionTraceResolvedVia}</span></div>
                  <div className="row"><span>Total</span><span>{decisionTraceTotalDurationMs.toFixed(0)} ms</span></div>
                  <div className="row"><span>SLA &lt; 10s</span><span className={decisionTraceSlaMet ? "good" : "warn"}>{decisionTraceSlaMet ? "met" : "missed"}</span></div>
                  <div className="row"><span>Partial</span><span className={decisionTracePartial ? "warn" : "good"}>{decisionTracePartial ? "yes" : "no"}</span></div>
                  <div className="row"><span>Phases</span><span>{decisionTracePhases.length}</span></div>
                  <div className="subtle mini" style={{ marginTop: 8 }}>
                    request: {String(decisionTraceRequestedIds.decision_id || decisionTraceRequestedIds.approval_id || selectedDecisionTraceId || "-")}
                  </div>
                </div>
                <div style={{ borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 10, background: "rgba(15, 23, 42, 0.22)" }}>
                  <div className="subtle mini">Explorer contract</div>
                  <div className="row" style={{ marginTop: 6 }}><span>Coverage</span><span>{decisionTraceCompletedCount}/{decisionTraceTimeline.length}</span></div>
                  <div className="row"><span>Missing</span><span className={decisionTraceMissingLabels.length > 0 ? "warn" : "good"}>{decisionTraceMissingLabels.length}</span></div>
                  <div className="row"><span>Blocked</span><span className={decisionTraceBlockedLabels.length > 0 ? "warn" : "good"}>{decisionTraceBlockedLabels.length}</span></div>
                  <div className="row"><span>Pending</span><span className={decisionTracePendingLabels.length > 0 ? "subtle" : "good"}>{decisionTracePendingLabels.length}</span></div>
                  <div className="subtle mini" style={{ marginTop: 8 }}>
                    {decisionTraceMissingLabels.length > 0 ? `missing: ${decisionTraceMissingLabels.join(" · ")}` : "Aucun maillon causal manquant sur la timeline attendue."}
                  </div>
                  {decisionTraceBlockedLabels.length > 0 ? (
                    <div className="subtle mini" style={{ marginTop: 4 }}>
                      blocked: {decisionTraceBlockedLabels.join(" · ")}
                    </div>
                  ) : null}
                </div>
              </div>
              {decisionTracePhases.length > 0 ? (
                <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 10, background: "rgba(2, 6, 23, 0.16)" }}>
                  <div className="subtle mini" style={{ marginBottom: 6 }}>Phase diagnostics</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {decisionTracePhases.map((phase, index) => {
                      const timedOut = Boolean(phase.timed_out);
                      const failed = Boolean(phase.failed);
                      const toneClass = timedOut || failed ? "warn" : "good";
                      return (
                        <div key={`${String(phase.phase_key || "phase")}-${index}`} className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                          <span>{String(phase.phase_key || `phase-${index + 1}`)}</span>
                          <span className={toneClass}>
                            {toNumber(phase.duration_ms, 0).toFixed(0)} ms · rows {toNumber(phase.rows, 0).toFixed(0)}
                            {timedOut ? " · timeout" : ""}
                            {failed ? " · failed" : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {decisionTraceTimeline.map((step, index) => {
                  const payload = asRecord(step.payload);
                  const actors = Array.isArray(step.actors) ? step.actors.map((item) => String(item)).filter(Boolean) : [];
                  return (
                    <div key={`${String(step.stage_key || "step")}-${index}`} style={{ borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.16)", padding: 10, background: "rgba(2, 6, 23, 0.16)" }}>
                      <div className="row"><span>{index + 1}. {String(step.label || step.stage_key || "step")}</span><span className={traceStatusClass(step.status)}>{String(step.status || "missing")}</span></div>
                      <div className="subtle mini" style={{ marginTop: 6 }}>{String(step.detail || "No detail")}</div>
                      <div className="subtle mini" style={{ marginTop: 4 }}>
                        {String(step.timestamp || "-")} · {actors.length > 0 ? actors.join(" · ") : String(payload.approval_stage || payload.status || "no-actor")}
                      </div>
                    </div>
                  );
                })}
              </div>
              {selectedDecisionTraceId ? (
                <p className="subtle mini" style={{ marginTop: 10 }}>
                  <Link href={`/api/system/decision-trace?decisionId=${encodeURIComponent(selectedDecisionTraceId)}&mode=lite`}>Ouvrir la trace JSON brute</Link>
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <OperatorActionSummary
            executionPnlPayload={executionPnlAnalyzerPayload}
            runtimeOpsPayload={liveOpsPayload}
            executionAiV6Payload={executionAiV6Payload}
            passiveMode
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
          <div className="row"><span>Mode backend actif</span><span>{effectiveBackendMode}</span></div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button type="button" disabled={systemModeBusy || effectiveBackendMode === "suggest"} onClick={() => { void changeSystemMode("suggest"); }}>
              Suggest
            </button>
            <button type="button" disabled={systemModeBusy || effectiveBackendMode === "guarded_auto"} onClick={() => { void changeSystemMode("guarded_auto"); }}>
              Guarded Auto
            </button>
            <button type="button" disabled={systemModeBusy || effectiveBackendMode === "managed_live"} onClick={() => { void changeSystemMode("managed_live"); }}>
              Managed Live
            </button>
          </div>
          {systemModeFeedback ? <p className="subtle" style={{ marginTop: 10 }}>{systemModeFeedback}</p> : null}
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel" data-testid="alpha-reactivation-console">
          <OperatorPanelGuide
            title="Alpha Reactivation Console"
            what="Flux unique: TXT propose, l'operateur approuve, TXT execute, puis les preuves ACK/FILL/OUTCOME/GAP sont mesurees."
            why="Eviter de perdre une session parce que l'approbation humaine attendait ailleurs."
            example="S'il y a une approval pending, le prochain geste operateur est visible ici."
            compact
          />
          <div className="row" style={{ marginTop: 10 }}>
            <span>Next action</span>
            <span className={alphaPanelTone}>{alphaNextAction}</span>
          </div>
          <div className="row"><span>Mode backend</span><span>{effectiveBackendMode}</span></div>
          <div className="row"><span>Pending approvals</span><span className={mt5PendingApprovals.length > 0 ? "warn" : "subtle"}>{mt5PendingApprovals.length}</span></div>
          <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.18)", padding: 12, background: "rgba(2, 6, 23, 0.18)" }}>
            <div className="row"><span>Proposition TXT</span><span>MT5 · {alphaMt5Symbol} · buy · 0.01 lot</span></div>
            <div className="row"><span>Notional estime</span><span>5 USD</span></div>
            <div className="row"><span>Spread max</span><span>10 bps</span></div>
            <div className="row"><span>But</span><span>renouveler FILL reel</span></div>
            <div className="subtle mini" style={{ marginTop: 8 }}>Ordre reel potentiel. Le compte live MT5 cree une demande en attente, puis un second operateur doit approuver.</div>
          </div>
          <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(56, 189, 248, 0.22)", padding: 12, background: "rgba(8, 47, 73, 0.22)" }}>
            <div className="row">
              <span>Opportunity score</span>
              <span className={opportunityScore >= 70 ? "good" : opportunityScore >= 50 ? "subtle" : "warn"}>{opportunityScore}/100</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: 10 }}>
              <div>
                <div className="subtle mini" style={{ marginBottom: 6 }}>Pourquoi proposer</div>
                {opportunityDrivers.map((item) => (
                  <div key={item.label} className="row" style={{ marginTop: 4 }}>
                    <span>{item.label}</span>
                    <span className="good">+{item.value}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="subtle mini" style={{ marginBottom: 6 }}>Risques</div>
                {opportunityRisks.length > 0 ? opportunityRisks.map((item) => (
                  <div key={item.label} className="row" style={{ marginTop: 4 }}>
                    <span>{item.label}</span>
                    <span className="warn">{item.value}</span>
                  </div>
                )) : (
                  <div className="subtle mini">Aucun risque principal detecte dans le snapshot courant.</div>
                )}
              </div>
            </div>
            <div className="subtle mini" style={{ marginTop: 8 }}>Ce score explique la demande operateur; il ne remplace pas le risk gateway ni la double approbation.</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button
              type="button"
              disabled={alphaSubmitBusy || Boolean(alphaSubmitBlockedReason)}
              onClick={() => { void submitAlphaReactivationRequest(); }}
            >
              {alphaSubmitBusy ? "Preparation..." : killSwitchActive ? "Verrouille" : "Preparer demande MT5"}
            </button>
            <button type="button" disabled={busy} onClick={() => { void loadData(); }}>
              Rafraichir preuves
            </button>
          </div>
          {alphaSubmitBlockedReason ? (
            <p className="subtle mini" style={{ marginTop: 8 }}>{alphaSubmitBlockedReason}</p>
          ) : null}
          {alphaFeedback ? <p className="subtle" style={{ marginTop: 10 }}>{alphaFeedback}</p> : null}
        </div>
        <div className="panel">
          <div className="eyebrow">Preuves 24h</div>
          <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
            {alphaProofSteps.map((step) => (
              <div key={step.id} className="row">
                <span>{step.id} · {step.label}</span>
                <span className={step.done ? "good" : "warn"}>{step.done ? "OK" : "manquant"} · {step.count}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="subtle mini" style={{ marginBottom: 6 }}>Approbations MT5 en attente</div>
            {mt5PendingApprovals.length > 0 ? (
              <div style={{ display: "grid", gap: 8 }}>
                {mt5PendingApprovals.map((approval) => {
                  const payload = approval.orderPayload;
                  return (
                    <div key={approval.approvalId} style={{ border: "1px solid rgba(148, 163, 184, 0.16)", borderRadius: 12, padding: 10, background: "rgba(15, 23, 42, 0.22)" }}>
                      <div className="row">
                        <span>{String(payload.symbol || "AUTO")} · {String(payload.side || "buy")}</span>
                        <span className="warn">approval pending</span>
                      </div>
                      <div className="subtle mini" style={{ marginTop: 4 }}>
                        id {approval.approvalId} · first {approval.firstApprovedBy} · account {approval.accountId}
                      </div>
                      <div className="subtle mini" style={{ marginTop: 4 }}>
                        lots {String(payload.lots || "0.01")} · notional {String(payload.estimated_notional_usd || "5")} USD · {approval.createdAt ? formatClock(approval.createdAt) : "-"}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <button
                          type="button"
                          disabled={Boolean(alphaApproveBusyId)}
                          onClick={() => { void approveAlphaReactivationRequest(approval.approvalId); }}
                        >
                          {alphaApproveBusyId === approval.approvalId ? "Approbation..." : "Approuver maintenant"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="subtle mini">Aucune approbation MT5 en attente. Si tu attendais un trade, c'est ici que l'attente doit apparaitre.</div>
            )}
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", marginBottom: 16 }}>
        <div className="panel">
          <OperatorPanelGuide
            title="Collecte Controlee"
            what="Cadre operateur pour produire des labels reaction x regime x outcome sans retomber dans une logique HFT ou scalping."
            why="Transformer le live en pipeline de collecte mesurable, pas en chasse au profit prematuree."
            example="Si le kill switch est reset et que l'opportunity gate est GO, ouvre seulement une session BingX / BTCUSDT / 7-7.5$."
            compact
          />
          <div className="row" style={{ marginTop: 10 }}><span>Status</span><span className={collectionTone}>{collectionStatus}</span></div>
          <div className="row"><span>Stage labels</span><span>{collectionStage}</span></div>
          <div className="row"><span>Labels classes</span><span>{collectionClassifiedCount} / {collectionTargetMin} min · {collectionTargetMax} plein</span></div>
          <div className="row"><span>Recent classes</span><span>{collectionRecentClassifiedCount}</span></div>
          <div className="row"><span>Progress min</span><span>{collectionProgressToMinPct.toFixed(0)}%</span></div>
          <div className="row"><span>Progress max</span><span>{collectionProgressToMaxPct.toFixed(0)}%</span></div>
          <div className="row"><span>Confiance edge</span><span>{String(collectionEdgeConfidence.level || "LOW")} · {toNumber(collectionEdgeConfidence.scorePct, 0).toFixed(0)}%</span></div>
          <p className="subtle" style={{ marginTop: 10 }}>{collectionThesis}</p>
          <p className="subtle mini" style={{ marginTop: 6 }}>{collectionNextAction}</p>
          <div style={{ marginTop: 10, height: 8, borderRadius: 999, background: "rgba(148, 163, 184, 0.14)", overflow: "hidden" }}>
            <div style={{ width: `${collectionProgressToMinPct}%`, height: "100%", background: collectionProgressToMinPct >= 100 ? "linear-gradient(90deg, rgba(34,197,94,0.9), rgba(16,185,129,0.9))" : "linear-gradient(90deg, rgba(56,189,248,0.9), rgba(14,165,233,0.9))" }} />
          </div>
          <div className="subtle mini" style={{ marginTop: 8 }}>{collectionLabelSummary}</div>
          <div className="subtle mini" style={{ marginTop: 4 }}>{collectionConfidenceSummary}</div>
        </div>
        <div className="panel">
          <div className="eyebrow">Cadre Non-Negociable</div>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Conditions fixes</div>
              <div style={{ display: "grid", gap: 6 }}>
                {collectionConstraints.map((item) => (
                  <div key={item} className="row"><span>{item}</span><span className="good">LOCK</span></div>
                ))}
              </div>
            </div>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>A ne pas faire</div>
              <div style={{ display: "grid", gap: 6 }}>
                {collectionForbidden.map((item) => (
                  <div key={item} className="row"><span>{item}</span><span className="warn">NO</span></div>
                ))}
              </div>
            </div>
            <div>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Stop immediat si</div>
              <div style={{ display: "grid", gap: 6 }}>
                {collectionStopConditions.map((item) => (
                  <div key={item} className="row"><span>{item}</span><span className="warn">STOP</span></div>
                ))}
              </div>
            </div>
            <div className="subtle mini">Encore {collectionToTargetMin} labels pour atteindre le seuil minimum exploitable.</div>
          </div>
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "1fr", marginBottom: 16 }}>
        <div className="panel">
          <ControlRoomMonitoringPanel
            badge={null}
            layoutEditMode={false}
            onDetach={() => {}}
            runtimeOpsPayload={liveOpsPayload}
            emergencyStopBusy={emergencyStopBusy}
            emergencyStopFeedback={emergencyStopFeedback}
            onEmergencyStop={() => { void triggerEmergencyStop(); }}
            formatClock={formatClock}
          />
        </div>
      </section>

      <section className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", marginBottom: 16 }}>
        <div className="panel">
          <ExecutionPnlTruthMonitoringPanel
            badge={null}
            layoutEditMode={false}
            onDetach={() => {}}
            payload={executionPnlAnalyzerPayload}
            runtimeOpsPayload={liveOpsPayload}
            executionAiV6Payload={executionAiV6Payload}
            passiveMode
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
          <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid rgba(148, 163, 184, 0.18)", padding: 12, background: "rgba(2, 6, 23, 0.18)" }}>
            <div className="row"><span>{UI_TERMS.decisionReality}</span><span className={decisionCoverageTone}>{decisionCoveragePct === null ? "n/a" : `${decisionCoveragePct.toFixed(2)}%`}</span></div>
            <div className="row"><span>Etat</span><span>{decisionRealityState}</span></div>
            <div className="row"><span>Couvertes</span><span>{decisionCoveredRows}</span></div>
            <div className="row"><span>Non couvertes</span><span>{decisionUncoveredRows}</span></div>
            <div className="row"><span>Observed but ignored</span><span>{decisionObservedIgnoredRows}{decisionObservedIgnoredRatePct === null ? "" : ` · ${decisionObservedIgnoredRatePct.toFixed(2)}%`}</span></div>
            <div className="row"><span>Gate alert ({decisionIgnoredGateThresholdPct.toFixed(1)}%)</span><span className={decisionIgnoredGateAlert ? "warn" : "good"}>{decisionIgnoredGateAlert ? "ALERT" : "OK"}</span></div>
            <div className="row"><span>Prochain gate</span><span>{decisionRealityNextGate}</span></div>
            {decisionTopUncoveredReasons.length > 0 ? (
              <div className="subtle mini" style={{ marginTop: 8 }}>
                Raisons principales: {decisionTopUncoveredReasons.map((item) => `${item.reason} (${item.count})`).join(" · ")}
              </div>
            ) : (
              <div className="subtle mini" style={{ marginTop: 8 }}>Raisons principales: n/a</div>
            )}
            {decisionCoverageBreakdown.length > 0 ? (
              <div style={{ marginTop: 10 }}>
                <div className="subtle mini" style={{ marginBottom: 6 }}>Decision Coverage Breakdown</div>
                {decisionCoverageBreakdown.map((item) => (
                  <div className="row" key={`${item.label}-${item.count}`} style={{ marginTop: 4 }}>
                    <span>{item.label}</span>
                    <span>{item.count}{item.sharePct === null ? "" : ` · ${item.sharePct.toFixed(2)}%`}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Trend couverture</div>
              {decisionCoverageTrendRows.map((row) => (
                <div className="row" key={row.label} style={{ marginTop: 4 }}>
                  <span>{row.label}</span>
                  <span>
                    used {row.observedUsedPct === null ? "n/a" : `${row.observedUsedPct.toFixed(2)}%`} · ignored {row.observedIgnoredPct === null ? "n/a" : `${row.observedIgnoredPct.toFixed(2)}%`} · n={row.sampleRows}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Alertes par decision_path (seuil {decisionPathIgnoredThresholdPct.toFixed(1)}%)</div>
              {decisionPathIgnoredAlerts.length > 0 ? decisionPathIgnoredAlerts.map((item) => (
                <div className="row" key={`${item.path}-${item.totalRows}-${item.ignoredRows}`} style={{ marginTop: 4 }}>
                  <span>{item.path}</span>
                  <span className={item.alert ? "warn" : "good"}>
                    ignored {item.ignoredRatePct === null ? "n/a" : `${item.ignoredRatePct.toFixed(2)}%`} · {item.ignoredRows}/{item.totalRows} · {item.alert ? "ALERT" : "OK"}
                  </span>
                </div>
              )) : (
                <div className="subtle mini">Aucune alerte par path sur la fenetre active.</div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>
                Alertes par path + reason (seuil ignored {decisionPathReasonIgnoredThresholdPct.toFixed(1)}% · seuil impact {decisionPathReasonImpactThresholdPctPoints.toFixed(2)} pts)
              </div>
              {decisionPathReasonIgnoredAlerts.length > 0 ? decisionPathReasonIgnoredAlerts.map((item) => (
                <div className="row" key={`${item.path}-${item.reason}-${item.totalRows}-${item.ignoredRows}`} style={{ marginTop: 4 }}>
                  <span>{item.path} · {item.reason}</span>
                  <span className={item.alert ? "warn" : "good"}>
                    ignored {item.ignoredRatePct === null ? "n/a" : `${item.ignoredRatePct.toFixed(2)}%`} · impact {item.impactPctPoints === null ? "n/a" : `${item.impactPctPoints.toFixed(2)} pts`} · vol {item.volumeSharePct === null ? "n/a" : `${item.volumeSharePct.toFixed(2)}%`} · {item.ignoredRows}/{item.totalRows} · {item.alert ? "ALERT" : "OK"}
                    {item.ignoredRateAlert ? " · by-rate" : ""}
                    {item.impactAlert ? " · by-impact" : ""}
                  </span>
                </div>
              )) : (
                <div className="subtle mini">Aucune alerte path+reason sur la fenetre active.</div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Top 3 remediation candidates (impact = % ignored × volume)</div>
              {decisionTopRemediationCandidates.length > 0 ? decisionTopRemediationCandidates.map((item, index) => (
                <div key={`${item.path}-${item.reason}-${index}`} style={{ marginTop: 6, border: "1px solid rgba(148, 163, 184, 0.12)", borderRadius: 10, padding: "6px 8px" }}>
                  <div className="row">
                    <span>#{index + 1} {item.path} · {item.reason}</span>
                    <span className={item.alert ? "warn" : "subtle"}>
                      impact {item.impactPctPoints === null ? "n/a" : `${item.impactPctPoints.toFixed(2)} pts`}
                      {item.ignoredRateAlert ? " · by-rate" : ""}
                      {item.impactAlert ? " · by-impact" : ""}
                    </span>
                  </div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>
                    ignored {item.ignoredRatePct === null ? "n/a" : `${item.ignoredRatePct.toFixed(2)}%`} · volume {item.volumeSharePct === null ? "n/a" : `${item.volumeSharePct.toFixed(2)}%`} · {item.ignoredRows}/{item.totalRows}
                  </div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>
                    action: {item.suggestedAction}
                  </div>
                </div>
              )) : (
                <div className="subtle mini">Aucune remediation candidate calculable sur la fenetre active.</div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Breakdown reasons · Quote observed but ignored</div>
              {decisionIgnoredReasonBreakdown.length > 0 ? decisionIgnoredReasonBreakdown.map((item) => (
                <div className="row" key={`${item.reason}-${item.count}`} style={{ marginTop: 4 }}>
                  <span>{item.reason}</span>
                  <span>{item.count}{item.sharePct === null ? "" : ` · ${item.sharePct.toFixed(2)}%`}</span>
                </div>
              )) : (
                <div className="subtle mini">Aucune raison instrumentee sur la fenetre active.</div>
              )}
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="subtle mini" style={{ marginBottom: 6 }}>Gate Cause Drilldown · Quote observed but ignored</div>
              {decisionIgnoredDrilldown.length > 0 ? decisionIgnoredDrilldown.map((item) => (
                <div key={`${item.path}-${item.source}-${item.reason}-${item.count}`} style={{ marginTop: 6, border: "1px solid rgba(148, 163, 184, 0.12)", borderRadius: 10, padding: "6px 8px" }}>
                  <div className="row">
                    <span>{item.path} · {item.source}</span>
                    <span>{item.count}{item.sharePct === null ? "" : ` · ${item.sharePct.toFixed(2)}%`}</span>
                  </div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>
                    reason: {item.reason}
                  </div>
                  <div className="subtle mini" style={{ marginTop: 4 }}>
                    decision_id recents: {item.recentDecisionIds.length > 0 ? item.recentDecisionIds.map((decisionId, index) => (
                      <span key={`${item.path}-${item.source}-${item.reason}-${decisionId}`}>
                        {index > 0 ? " · " : ""}
                        <Link href={`/advanced/reality-gap?decisionId=${encodeURIComponent(decisionId)}`}>{decisionId}</Link>
                      </span>
                    )) : "n/a"}
                  </div>
                </div>
              )) : (
                <div className="subtle mini">Aucune decision quote_observed_but_ignored sur la fenetre active.</div>
              )}
            </div>
          </div>
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
