import type { MiroFishSimulationResult } from "./mirofishLite";
import type { SelfLearningV5RegistryEntry } from "./selfLearningV5Store";

export type MissionControlPerformance = {
  pnlPct: number;
  winratePct: number;
  sharpe: number;
  drawdownPct: number;
};

export type MissionControlAi = {
  activeAgents: number;
  miroConfidence: number;
  mlScore: number;
  microScore: number;
  liquidityScore: number;
  liquidityAccuracy: number;
  liquidityState: string;
  finalScore: number;
  predictedDirection: string;
  activeStrategyId: string | null;
};

export type MissionControlRisk = {
  exposurePct: number;
  correlation: number;
  riskState: "NORMAL" | "ELEVATED" | "BLOCKED";
};

export type MissionControlSnapshot = {
  performance: MissionControlPerformance;
  ai: MissionControlAi;
  risk: MissionControlRisk;
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function buildMissionControlSnapshot(input: {
  pnlPct: number;
  winratePct: number;
  sharpe: number;
  drawdownPct: number;
  miro: MiroFishSimulationResult;
  mlScore: number;
  microScore: number;
  liquidityScore: number;
  liquidityAccuracy: number;
  liquidityState: string;
  finalScore: number;
  exposurePct: number;
  correlation: number;
  riskBlocked: boolean;
  activeStrategy: SelfLearningV5RegistryEntry | null;
}): MissionControlSnapshot {
  const elevatedRisk = input.drawdownPct >= 3 || input.exposurePct >= 6 || input.correlation >= 0.7;
  return {
    performance: {
      pnlPct: input.pnlPct,
      winratePct: input.winratePct,
      sharpe: input.sharpe,
      drawdownPct: input.drawdownPct,
    },
    ai: {
      activeAgents: input.miro.agents.length,
      miroConfidence: input.miro.confidence,
      mlScore: clamp(input.mlScore, 0, 1),
      microScore: clamp(input.microScore, 0, 1),
      liquidityScore: clamp(input.liquidityScore, 0, 1),
      liquidityAccuracy: clamp(input.liquidityAccuracy, 0, 1),
      liquidityState: input.liquidityState,
      finalScore: clamp(input.finalScore, 0, 1),
      predictedDirection: input.miro.predictedDirection,
      activeStrategyId: input.activeStrategy?.id || null,
    },
    risk: {
      exposurePct: input.exposurePct,
      correlation: input.correlation,
      riskState: input.riskBlocked ? "BLOCKED" : elevatedRisk ? "ELEVATED" : "NORMAL",
    },
  };
}