export type RiskAIState = {
  drawdown: number;
  volatility: number;
  latency: number;
  correlation: number;
  swarmConfidence?: number;
};

export type RiskAIDecision = {
  allow: boolean;
  reason: string;
  blockers: string[];
};

export function riskGate(state: RiskAIState): RiskAIDecision {
  const drawdown = Math.max(0, state.drawdown);
  const volatility = Math.max(0, state.volatility);
  const latency = Math.max(0, state.latency);
  const correlation = Math.max(0, state.correlation);
  const swarmConfidence = Math.max(0, Math.min(1, state.swarmConfidence ?? 1));
  const blockers: string[] = [];

  if (drawdown > 0.05) {
    blockers.push("MAX_DRAWDOWN");
  }
  if (volatility > 0.95) {
    blockers.push("EXTREME_VOLATILITY");
  }
  if (latency > 200) {
    blockers.push("LATENCY_RISK");
  }
  if (correlation > 0.8) {
    blockers.push("OVEREXPOSURE");
  }
  if (swarmConfidence < 0.2 && (volatility > 0.8 || correlation > 0.7)) {
    blockers.push("LOW_SWARM_CONFIDENCE");
  }

  return {
    allow: blockers.length === 0,
    reason: blockers[0] || (swarmConfidence < 0.4 ? "ALLOW_WITH_SWARM_DISCOUNT" : "ALLOW"),
    blockers,
  };
}