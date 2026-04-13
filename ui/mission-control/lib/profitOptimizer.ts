export type ProfitOptimizerState = {
  unrealizedPnlPct: number;
  maxPnlPct: number;
  microScore: number;
  absorptionProb: number;
  swarmConfidence?: number;
  liquidityStress?: number;
  exhaustion: boolean;
};

export type ProfitOptimizerDecision = {
  action: "HOLD" | "EXIT";
  reason: "NONE" | "EXHAUSTION" | "TRAILING_STOP" | "WEAK_SIGNAL" | "SWARM_LOCK" | "LIQUIDITY_FAILURE";
  drawdownPct: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function computeExitDecision(state: ProfitOptimizerState): ProfitOptimizerDecision {
  const unrealizedPnlPct = Number.isFinite(state.unrealizedPnlPct) ? state.unrealizedPnlPct : 0;
  const maxPnlPct = Math.max(unrealizedPnlPct, Number.isFinite(state.maxPnlPct) ? state.maxPnlPct : unrealizedPnlPct);
  const microScore = clamp(state.microScore, 0, 1);
  const absorptionProb = clamp(state.absorptionProb, 0, 1);
  const swarmConfidence = clamp(state.swarmConfidence ?? 0, 0, 1);
  const liquidityStress = clamp(state.liquidityStress ?? 0, 0, 1);
  const drawdownPct = Math.max(0, maxPnlPct - unrealizedPnlPct);

  if (unrealizedPnlPct > 0.8 && state.exhaustion) {
    return { action: "EXIT", reason: "EXHAUSTION", drawdownPct };
  }

  if (liquidityStress >= 0.72 && unrealizedPnlPct > 0.15) {
    return { action: "EXIT", reason: "LIQUIDITY_FAILURE", drawdownPct };
  }

  if (unrealizedPnlPct > 0.6 && swarmConfidence >= 0.82 && drawdownPct > 0.12) {
    return { action: "EXIT", reason: "SWARM_LOCK", drawdownPct };
  }

  if (drawdownPct > 0.3 && unrealizedPnlPct > 0.5) {
    return { action: "EXIT", reason: "TRAILING_STOP", drawdownPct };
  }

  if (microScore < 0.4 && absorptionProb < 0.5) {
    return { action: "EXIT", reason: "WEAK_SIGNAL", drawdownPct };
  }

  return { action: "HOLD", reason: "NONE", drawdownPct };
}