export type PositionSizingContext = {
  microScore: number;
  mlProb: number;
  volatility: number;
  swarmConfidence?: number;
};

export type PositionSizingDecision = {
  multiplier: number;
  reasons: string[];
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function computePositionSize(context: PositionSizingContext): PositionSizingDecision {
  const microScore = clamp(context.microScore, 0, 1);
  const mlProb = clamp(context.mlProb, 0, 1);
  const volatility = Math.max(0, context.volatility);
  const swarmConfidence = clamp(context.swarmConfidence ?? 1, 0, 1);
  const reasons: string[] = [];

  let multiplier = 1;
  multiplier *= Math.max(0.1, microScore);
  multiplier *= Math.max(0.1, mlProb);
  multiplier *= 0.55 + swarmConfidence * 0.45;

  if (volatility > 0.8) {
    multiplier *= 0.5;
    reasons.push("high_volatility_size_reduction");
  }
  if (swarmConfidence < 0.45) {
    reasons.push("low_swarm_confidence_size_reduction");
  }
  if (microScore >= 0.75 && mlProb >= 0.75) {
    reasons.push("high_conviction_signal");
  }
  if (swarmConfidence >= 0.75) {
    reasons.push("swarm_confidence_support");
  }

  return {
    multiplier: clamp(multiplier, 0.1, 3),
    reasons,
  };
}