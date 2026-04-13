export type ExecutionDominationInput = {
  latencyEdgeMs: number;
  liquidityAdvantage: number;
  executionQuality: number;
  fillProbability: number;
  slippageBps: number;
  riskScore: number;
};

export type ExecutionDominationSignal = {
  dominationScore: number;
  state: "WEAK" | "BALANCED" | "DOMINANT";
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeExecutionDomination(input: ExecutionDominationInput): ExecutionDominationSignal {
  const latencyEdgeScore = clamp((input.latencyEdgeMs + 50) / 150, 0, 1);
  const liquidityScore = clamp(input.liquidityAdvantage, 0, 1);
  const executionQuality = clamp(input.executionQuality, 0, 1);
  const fillProbability = clamp(input.fillProbability, 0, 1);
  const slippagePenalty = clamp(input.slippageBps / 20, 0, 1);
  const riskPenalty = clamp(input.riskScore, 0, 1);
  const dominationScore = clamp(
    latencyEdgeScore * 0.2
      + liquidityScore * 0.22
      + executionQuality * 0.22
      + fillProbability * 0.18
      + (1 - slippagePenalty) * 0.1
      + (1 - riskPenalty) * 0.08,
    0,
    1,
  );
  return {
    dominationScore: Number(dominationScore.toFixed(4)),
    state: dominationScore >= 0.72 ? "DOMINANT" : dominationScore >= 0.45 ? "BALANCED" : "WEAK",
  };
}