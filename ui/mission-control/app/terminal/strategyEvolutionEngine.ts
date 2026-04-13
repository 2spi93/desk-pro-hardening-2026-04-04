type StrategyEvolutionOutcome = {
  success: boolean;
  pnlBps: number;
};

export type StrategyEvolutionSnapshot = {
  evolutionMode: "COMPOUND" | "PRESERVE" | "DE_RISK" | "SHADOW_LEARN" | "HALT";
  capitalMode: "growth" | "balanced" | "capital-preservation" | "shadow" | "halt";
  selectedStrategy: string;
  allocationShift: number;
  learningBias: number;
  preservePipeline: boolean;
  allocationPills: string[];
  reasons: string[];
};

export type StrategyEvolutionInput = {
  selectedAgent: string;
  institutionalHealthScore: number;
  adaptiveConfidence: number;
  adaptivePerformance: number;
  adaptiveAction: string;
  stabilityBlocked: boolean;
  stabilityMode: string;
  stabilityMonitorScore: number;
  schedulerAction: string;
  schedulerPartialFillRatio: number;
  schedulerScheduleScore: number;
  metaRiskHealthScore: number;
  dailyDrawdownPct: number;
  currentStrategyMode: string;
  outcomes: StrategyEvolutionOutcome[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildStrategyEvolutionSnapshot(input: StrategyEvolutionInput): StrategyEvolutionSnapshot {
  const recent = input.outcomes.slice(0, 12);
  const winRate = recent.length > 0 ? recent.filter((item) => item.success).length / recent.length : 0.5;
  const avgPnlBps = recent.length > 0 ? recent.reduce((sum, item) => sum + item.pnlBps, 0) / recent.length : 0;
  const drawdownStress = clamp(input.dailyDrawdownPct / 10, 0, 1);
  const executionStress = clamp(input.schedulerPartialFillRatio * 1.2 + Math.max(0, 1 - input.schedulerScheduleScore), 0, 1.5);

  let evolutionMode: StrategyEvolutionSnapshot["evolutionMode"] = "PRESERVE";
  let capitalMode: StrategyEvolutionSnapshot["capitalMode"] = "balanced";
  let allocationShift = 0;
  let learningBias = 0.45;
  const reasons: string[] = [];

  if (input.stabilityBlocked) {
    evolutionMode = "HALT";
    capitalMode = "halt";
    allocationShift = -0.4;
    learningBias = 0.85;
    reasons.push("stability_block");
  } else if (input.stabilityMode === "shadow") {
    evolutionMode = "SHADOW_LEARN";
    capitalMode = "shadow";
    allocationShift = -0.15;
    learningBias = 0.78;
    reasons.push("shadow_comparator_priority");
  } else if (drawdownStress >= 0.45 || executionStress >= 0.55 || input.metaRiskHealthScore < 0.55) {
    evolutionMode = "DE_RISK";
    capitalMode = "capital-preservation";
    allocationShift = -0.18;
    learningBias = 0.68;
    reasons.push("capital_preservation");
  } else if (
    input.institutionalHealthScore >= 0.72
    && input.stabilityMonitorScore >= 0.7
    && input.schedulerScheduleScore >= 0.65
    && winRate >= 0.58
    && avgPnlBps > 0
    && input.adaptiveAction === "execute"
  ) {
    evolutionMode = "COMPOUND";
    capitalMode = "growth";
    allocationShift = 0.14;
    learningBias = 0.34;
    reasons.push("compound_winner");
  }

  if (input.currentStrategyMode) {
    reasons.push(`strategy:${input.currentStrategyMode.toLowerCase()}`);
  }

  const reserveWeight = clamp(
    capitalMode === "halt"
      ? 0.75
      : capitalMode === "shadow"
        ? 0.38
        : capitalMode === "capital-preservation"
          ? 0.42
          : capitalMode === "growth"
            ? 0.16
            : 0.24,
    0.1,
    0.8,
  );
  const shadowWeight = clamp(learningBias * 0.35 + (capitalMode === "shadow" ? 0.22 : 0), 0.1, 0.55);
  const activeWeight = clamp(1 - reserveWeight - shadowWeight, 0.12, 0.72);

  return {
    evolutionMode,
    capitalMode,
    selectedStrategy: input.selectedAgent,
    allocationShift,
    learningBias,
    preservePipeline: true,
    allocationPills: [
      `${input.selectedAgent} ${(activeWeight * 100).toFixed(0)}%`,
      `reserve ${(reserveWeight * 100).toFixed(0)}%`,
      `shadow ${(shadowWeight * 100).toFixed(0)}%`,
      `wr ${(winRate * 100).toFixed(0)}% · pnl ${avgPnlBps >= 0 ? "+" : ""}${avgPnlBps.toFixed(1)}bps`,
    ],
    reasons,
  };
}