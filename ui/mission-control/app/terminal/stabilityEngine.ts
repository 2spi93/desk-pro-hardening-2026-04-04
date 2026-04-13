export type StabilityAlert = {
  severity: "info" | "warn" | "critical";
  label: string;
  detail: string;
};

export type StabilitySnapshot = {
  mode: "live" | "guarded" | "shadow" | "halted";
  monitorScore: number;
  driftWatchdog: "CALM" | "WATCH" | "DRIFT" | "CRITICAL";
  shadowFallbackRatePct: number;
  timeoutRatePct: number;
  dnsTransientRatePct: number;
  degradedUsageRatioPct: number;
  externalKillSwitchActive: boolean;
  shouldBlockExecution: boolean;
  comparatorLabel: string;
  alerts: StabilityAlert[];
  reasons: string[];
};

export type StabilityEngineInput = {
  externalKillSwitchActive: boolean;
  operatorKillSwitchActive: boolean;
  shadowFallbackRatePct: number;
  shadowDiffEvents: number;
  timeoutRatePct: number;
  dnsTransientRatePct: number;
  degradedUsageRatioPct: number;
  institutionalHealthScore: number;
  warfareExecutionScore: number;
  schedulerScore: number;
  selfHealingAction: string;
  selfHealingDrift: string;
  selfHealingExecutionEnabled: boolean;
  pendingApprovals: number;
  blockedCount: number;
  partialCount: number;
  filledCount: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  dailyDrawdownPct: number;
  metaRiskHealthScore: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildStabilitySnapshot(input: StabilityEngineInput): StabilitySnapshot {
  const lifecycleCount = Math.max(1, input.pendingApprovals + input.blockedCount + input.partialCount + input.filledCount);
  const blockedRatio = input.blockedCount / lifecycleCount;
  const partialRatio = input.partialCount / lifecycleCount;
  const networkStress = clamp(
    Math.max(input.timeoutRatePct, input.dnsTransientRatePct, input.degradedUsageRatioPct) / 100,
    0,
    1,
  );
  const shadowStress = clamp(input.shadowFallbackRatePct / 100, 0, 1);
  const drawdownStress = clamp(input.dailyDrawdownPct / 10, 0, 1);
  const driftPressure = clamp(
    (input.selfHealingDrift === "LOSS_SPIRAL" ? 0.65 : input.selfHealingDrift === "EXECUTION_DRIFT" ? 0.42 : 0.1)
      + blockedRatio * 0.55
      + partialRatio * 0.25,
    0,
    1.6,
  );
  const monitorScore = clamp(
    input.institutionalHealthScore * 0.24
      + input.warfareExecutionScore * 0.18
      + input.schedulerScore * 0.14
      + input.metaRiskHealthScore * 0.14
      + Math.max(0, 1 - networkStress) * 0.11
      + Math.max(0, 1 - shadowStress) * 0.09
      + Math.max(0, 1 - clamp(input.avgLatencyMs / 900, 0, 1)) * 0.05
      + Math.max(0, 1 - clamp(Math.abs(input.avgSlippageBps) / 24, 0, 1)) * 0.05
      - drawdownStress * 0.12
      - driftPressure * 0.1,
    0,
    1,
  );

  const shouldBlockExecution = input.externalKillSwitchActive
    || input.operatorKillSwitchActive
    || !input.selfHealingExecutionEnabled
    || monitorScore < 0.33
    || driftPressure >= 1.05;
  const mode: StabilitySnapshot["mode"] = shouldBlockExecution
    ? "halted"
    : shadowStress >= 0.06 || networkStress >= 0.08
      ? "shadow"
      : monitorScore < 0.58 || driftPressure >= 0.55
        ? "guarded"
        : "live";
  const driftWatchdog: StabilitySnapshot["driftWatchdog"] = shouldBlockExecution
    ? "CRITICAL"
    : driftPressure >= 0.75
      ? "DRIFT"
      : driftPressure >= 0.4 || partialRatio >= 0.2
        ? "WATCH"
        : "CALM";
  const comparatorLabel = `fallback ${input.shadowFallbackRatePct.toFixed(2)}% · diff ${input.shadowDiffEvents} · net ${input.timeoutRatePct.toFixed(1)}/${input.dnsTransientRatePct.toFixed(1)}/${input.degradedUsageRatioPct.toFixed(1)}%`;
  const alerts: StabilityAlert[] = [];
  const reasons: string[] = [];

  if (input.externalKillSwitchActive) {
    alerts.push({ severity: "critical", label: "External kill-switch", detail: "Control-plane kill-switch active." });
    reasons.push("external_kill_switch");
  }
  if (input.operatorKillSwitchActive) {
    alerts.push({ severity: "critical", label: "Operator kill-switch", detail: "Manual execution kill-switch active." });
    reasons.push("operator_kill_switch");
  }
  if (!input.selfHealingExecutionEnabled) {
    alerts.push({ severity: "critical", label: "Recovery mode", detail: `${input.selfHealingAction} prevents live execution.` });
    reasons.push(`heal:${input.selfHealingAction.toLowerCase()}`);
  }
  if (partialRatio >= 0.2) {
    alerts.push({ severity: "warn", label: "Partial-fill drift", detail: `${(partialRatio * 100).toFixed(0)}% of recent lifecycle events are partial.` });
    reasons.push("partial_fill_watchdog");
  }
  if (blockedRatio >= 0.2) {
    alerts.push({ severity: "warn", label: "Block ratio", detail: `${(blockedRatio * 100).toFixed(0)}% of recent lifecycle events are blocked.` });
    reasons.push("blocked_ratio_high");
  }
  if (shadowStress >= 0.06) {
    alerts.push({ severity: "warn", label: "Shadow fallback", detail: `Fallback rate ${input.shadowFallbackRatePct.toFixed(2)}%.` });
    reasons.push("shadow_fallback_rising");
  }
  if (networkStress >= 0.08) {
    alerts.push({ severity: "warn", label: "Network drift", detail: comparatorLabel });
    reasons.push("network_drift_watchdog");
  }
  if (monitorScore >= 0.75 && alerts.length === 0) {
    alerts.push({ severity: "info", label: "Stable execution", detail: "Live comparator and lifecycle metrics nominal." });
  }

  return {
    mode,
    monitorScore,
    driftWatchdog,
    shadowFallbackRatePct: input.shadowFallbackRatePct,
    timeoutRatePct: input.timeoutRatePct,
    dnsTransientRatePct: input.dnsTransientRatePct,
    degradedUsageRatioPct: input.degradedUsageRatioPct,
    externalKillSwitchActive: input.externalKillSwitchActive,
    shouldBlockExecution,
    comparatorLabel,
    alerts,
    reasons,
  };
}