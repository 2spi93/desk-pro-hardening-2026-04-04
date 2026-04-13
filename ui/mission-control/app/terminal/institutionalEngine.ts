import type { AdaptiveSnapshot, RealityGapFeedback, AdaptiveOutcome } from "./adaptiveEngine";

export type DriftStatus = "STABLE" | "EXECUTION_DRIFT" | "LOSS_SPIRAL";

export type SelfHealingSnapshot = {
  mode: "normal" | "defensive" | "paper";
  riskMultiplier: number;
  action: "SAFE" | "LIMIT_TRADING" | "KILL" | "RECOVERY";
  drift: DriftStatus;
  lossRate: number;
  executionEnabled: boolean;
  dominantFailureSource: string;
  adaptSpeed: number;
  reasons: string[];
};

export type InstitutionalAgent = {
  id: "micro" | "intraday" | "swing" | "risk" | "execution";
  label: string;
  confidence: number;
  performance: number;
  weight: number;
};

export type CapitalAllocation = {
  strategy: string;
  weight: number;
};

export type InstitutionalExecutionProfile = {
  style: "aggressive" | "passive" | "stealth" | "iceberg" | "smart-routing";
  sizeMultiplier: number;
};

export type InstitutionalSnapshot = {
  selectedAgent: string;
  capitalAllocation: CapitalAllocation[];
  execution: InstitutionalExecutionProfile;
  systemHealthScore: number;
  healthState: "strong" | "guarded" | "degraded";
  memoryGraphLabel: string;
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeAverage(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function antiLossSpiral(state: { lossStreak: number }): Pick<SelfHealingSnapshot, "mode" | "riskMultiplier" | "action" | "reasons"> {
  if (state.lossStreak >= 3) {
    return {
      mode: "defensive",
      riskMultiplier: 0.4,
      action: "LIMIT_TRADING",
      reasons: ["loss_spiral_guard"],
    };
  }
  return {
    mode: "normal",
    riskMultiplier: 1,
    action: "SAFE",
    reasons: [],
  };
}

export function detectDrift(gapHistory: RealityGapFeedback[]): DriftStatus {
  const avgSlippage = safeAverage(gapHistory.map((item) => item.slippageGapBps), 0);
  const avgFillGap = safeAverage(gapHistory.map((item) => item.fillProbabilityGap), 0);
  if (avgSlippage > 2 || avgFillGap > 0.5) {
    return "EXECUTION_DRIFT";
  }
  return "STABLE";
}

export function smartKillSwitch(state: {
  confidence: number;
  lossRate: number;
  drift: DriftStatus;
}): "KILL" | "SAFE" {
  if (state.confidence < 0.3 && state.lossRate > 0.6 && state.drift === "EXECUTION_DRIFT") {
    return "KILL";
  }
  return "SAFE";
}

export function recoveryMode(): Pick<SelfHealingSnapshot, "mode" | "riskMultiplier" | "action" | "executionEnabled" | "reasons"> {
  return {
    mode: "paper",
    riskMultiplier: 0.2,
    action: "RECOVERY",
    executionEnabled: false,
    reasons: ["recovery_mode"],
  };
}

export function buildSelfHealingSnapshot(input: {
  adaptive: AdaptiveSnapshot;
  outcomes: AdaptiveOutcome[];
  gaps: RealityGapFeedback[];
}): SelfHealingSnapshot {
  const lossRate = input.outcomes.length > 0
    ? input.outcomes.filter((item) => !item.success).length / input.outcomes.length
    : 0;
  const drift = input.adaptive.state.lossStreak >= 3 ? "LOSS_SPIRAL" : detectDrift(input.gaps);
  const spiral = antiLossSpiral({ lossStreak: input.adaptive.state.lossStreak });
  const kill = smartKillSwitch({
    confidence: input.adaptive.state.confidence,
    lossRate,
    drift,
  });

  if (kill === "KILL") {
    const recovery = recoveryMode();
    return {
      mode: recovery.mode,
      riskMultiplier: recovery.riskMultiplier,
      action: recovery.action,
      drift,
      lossRate,
      executionEnabled: recovery.executionEnabled,
      dominantFailureSource: input.adaptive.correction.dominantFailureSource,
      adaptSpeed: input.adaptive.state.adaptSpeed,
      reasons: [...spiral.reasons, ...recovery.reasons, "smart_kill_switch"],
    };
  }

  return {
    mode: spiral.mode,
    riskMultiplier: clamp(spiral.riskMultiplier * (drift === "EXECUTION_DRIFT" ? 0.7 : 1), 0.2, 1),
    action: spiral.action,
    drift,
    lossRate,
    executionEnabled: true,
    dominantFailureSource: input.adaptive.correction.dominantFailureSource,
    adaptSpeed: input.adaptive.state.adaptSpeed,
    reasons: [...spiral.reasons, ...(drift === "EXECUTION_DRIFT" ? ["execution_drift_detected"] : [])],
  };
}

export function selectAgent(regime: string): string {
  if (regime === "trend" || regime === "breakout") return "trend_agent";
  if (regime === "chaos") return "defensive_agent";
  if (regime === "dead") return "execution_agent";
  return "intraday_agent";
}

export function allocateCapital(agents: InstitutionalAgent[]): CapitalAllocation[] {
  const raw = agents.map((agent) => ({
    strategy: agent.label,
    weight: Math.max(0.01, agent.performance * agent.confidence),
  }));
  const total = raw.reduce((sum, item) => sum + item.weight, 0);
  return raw.map((item) => ({
    strategy: item.strategy,
    weight: total > 0 ? item.weight / total : 0,
  })).sort((left, right) => right.weight - left.weight);
}

export function computeSystemHealth(input: {
  performance: number;
  executionQuality: number;
  stability: number;
  drawdown: number;
}): number {
  return clamp(
    input.performance * 0.38
      + input.executionQuality * 0.28
      + input.stability * 0.22
      - input.drawdown * 0.18,
    0,
    1,
  );
}

export function buildInstitutionalSnapshot(input: {
  adaptive: AdaptiveSnapshot;
  healing: SelfHealingSnapshot;
  agentVotes: Array<{ name: string; confidence: number; performance?: number }>;
  drawdownPct: number;
  executionQuality: number;
  stability: number;
  memoryLabel: string;
}): InstitutionalSnapshot {
  const baseAgents: InstitutionalAgent[] = [
    { id: "micro", label: "Agent Micro", confidence: 0.5, performance: input.adaptive.state.performance, weight: 1 },
    { id: "intraday", label: "Agent Intraday", confidence: 0.55, performance: input.adaptive.state.performance, weight: 1 },
    { id: "swing", label: "Agent Swing", confidence: 0.45, performance: input.adaptive.state.performance * 0.92, weight: 1 },
    { id: "risk", label: "Agent Risk", confidence: 0.7, performance: 0.8, weight: 1 },
    { id: "execution", label: "Agent Execution", confidence: input.executionQuality, performance: input.executionQuality, weight: 1 },
  ];

  for (const vote of input.agentVotes.slice(0, 5)) {
    const normalized = vote.name.toLowerCase();
    const target = baseAgents.find((agent) => normalized.includes(agent.id) || normalized.includes(agent.label.toLowerCase().split(" ")[1] || ""));
    if (target) {
      target.confidence = clamp(vote.confidence, 0, 1);
      target.performance = clamp(vote.performance ?? target.performance, 0, 1);
    }
  }

  const selectedAgent = selectAgent(input.adaptive.state.regime);
  const capitalAllocation = allocateCapital(baseAgents);
  const healthScore = computeSystemHealth({
    performance: input.adaptive.state.performance,
    executionQuality: input.executionQuality,
    stability: input.stability,
    drawdown: Math.max(0, input.drawdownPct) / 100,
  });
  const healthState = healthScore >= 0.72 ? "strong" : healthScore >= 0.45 ? "guarded" : "degraded";
  const executionStyle = input.healing.mode === "paper"
    ? "smart-routing"
    : input.healing.drift === "EXECUTION_DRIFT"
      ? "iceberg"
      : input.adaptive.strategy.executionStyle === "aggressive"
        ? "aggressive"
        : input.adaptive.strategy.executionStyle === "passive"
          ? "passive"
          : selectedAgent === "trend_agent"
            ? "stealth"
            : "smart-routing";

  return {
    selectedAgent,
    capitalAllocation,
    execution: {
      style: executionStyle,
      sizeMultiplier: clamp(input.adaptive.strategy.sizeMultiplier * input.healing.riskMultiplier, 0.1, 1.5),
    },
    systemHealthScore: healthScore,
    healthState,
    memoryGraphLabel: input.memoryLabel,
    reasons: [
      `heal:${input.healing.action.toLowerCase()}`,
      `drift:${input.healing.drift.toLowerCase()}`,
      `agent:${selectedAgent}`,
    ],
  };
}