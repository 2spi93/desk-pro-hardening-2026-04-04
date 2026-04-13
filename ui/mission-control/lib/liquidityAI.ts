export type LiquidityAIPredictedState = "wall-forming" | "vacuum" | "absorption-failure" | "balanced";

export type LiquidityAIPredictedPressure = "buy" | "sell" | "neutral";

export type LiquidityAIInput = {
  imbalance: number;
  delta: number;
  domDensity: number;
  orderflowQuality: number;
  microNoiseScore: number;
  spreadBps: number;
  volatilityBps: number;
  vwapSlopeBps: number;
  liquidityEngineScore: number;
  liquidityVacuum: number;
  sweepRisk: number;
  restingImbalance: number;
  touchDensity: number;
  absorptionProb: number;
  spoofingScore: number;
  liquidityWallDetected: boolean;
};

export type LiquidityAISnapshot = {
  wallFormationProbability: number;
  liquidityVacuumProbability: number;
  absorptionFailureProbability: number;
  liquidityScore: number;
  directionalBias: number;
  confidence: number;
  predictedState: LiquidityAIPredictedState;
  predictedPressure: LiquidityAIPredictedPressure;
  entryBoost: number;
  earlyExitRisk: number;
  hedgeBoost: number;
  reasons: string[];
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

export function buildPredictiveLiquiditySnapshot(input: LiquidityAIInput): LiquidityAISnapshot {
  const imbalance = clamp(input.imbalance, -1, 1);
  const delta = clamp(input.delta / 250000, -1, 1);
  const domDensity = clamp(input.domDensity, 0, 1);
  const orderflowQuality = clamp(input.orderflowQuality, 0, 1);
  const microNoiseScore = clamp(input.microNoiseScore, 0, 1);
  const spreadStress = clamp(input.spreadBps / 18, 0, 1);
  const volatilityStress = clamp(input.volatilityBps / 32, 0, 1);
  const vwapSlope = clamp(input.vwapSlopeBps / 10, -1, 1);
  const liquidityEngineScore = clamp(input.liquidityEngineScore, 0, 1);
  const liquidityVacuum = clamp(input.liquidityVacuum, 0, 1);
  const sweepRisk = clamp(input.sweepRisk, 0, 1);
  const restingImbalance = clamp(input.restingImbalance, -1, 1);
  const touchDensity = clamp(input.touchDensity, 0, 1);
  const absorptionProb = clamp(input.absorptionProb, 0, 1);
  const spoofingScore = clamp(input.spoofingScore, 0, 1);

  const directionalBias = clamp(
    restingImbalance * 0.42
      + imbalance * 0.34
      + delta * 0.14
      + vwapSlope * 0.1,
    -1,
    1,
  );
  const pressureMagnitude = Math.abs(directionalBias);
  const wallFormationProbability = clamp(
    liquidityEngineScore * 0.32
      + domDensity * 0.18
      + touchDensity * 0.12
      + pressureMagnitude * 0.12
      + orderflowQuality * 0.14
      + (1 - microNoiseScore) * 0.08
      + (1 - spreadStress) * 0.04
      + (input.liquidityWallDetected ? 0.12 : 0),
    0,
    1,
  );
  const liquidityVacuumProbability = clamp(
    liquidityVacuum * 0.36
      + sweepRisk * 0.22
      + spreadStress * 0.14
      + volatilityStress * 0.12
      + microNoiseScore * 0.1
      + spoofingScore * 0.06,
    0,
    1,
  );
  const absorptionFailureProbability = clamp(
    Math.max(0, absorptionProb - 0.52) * 0.34
      + liquidityVacuumProbability * 0.24
      + microNoiseScore * 0.14
      + volatilityStress * 0.1
      + (1 - orderflowQuality) * 0.1
      + pressureMagnitude * 0.08,
    0,
    1,
  );
  const liquidityScore = clamp(
    wallFormationProbability * 0.44
      + liquidityEngineScore * 0.18
      + orderflowQuality * 0.12
      + (1 - liquidityVacuumProbability) * 0.14
      + (1 - absorptionFailureProbability) * 0.12,
    0,
    1,
  );
  const confidence = clamp(
    orderflowQuality * 0.28
      + (1 - microNoiseScore) * 0.18
      + domDensity * 0.14
      + touchDensity * 0.1
      + pressureMagnitude * 0.1
      + (1 - spreadStress) * 0.08
      + (1 - volatilityStress) * 0.06
      + liquidityEngineScore * 0.06,
    0,
    1,
  );
  const predictedState: LiquidityAIPredictedState = absorptionFailureProbability >= 0.66
    ? "absorption-failure"
    : liquidityVacuumProbability >= 0.62
      ? "vacuum"
      : wallFormationProbability >= 0.6
        ? "wall-forming"
        : "balanced";
  const predictedPressure: LiquidityAIPredictedPressure = directionalBias >= 0.14
    ? "buy"
    : directionalBias <= -0.14
      ? "sell"
      : "neutral";
  const fragilityScore = Math.max(liquidityVacuumProbability, absorptionFailureProbability);
  const entryBoost = clamp(
    Math.max(0, liquidityScore - 0.52) * 0.2
      + Math.max(0, wallFormationProbability - 0.55) * 0.08
      - fragilityScore * 0.1,
    0,
    0.2,
  );
  const earlyExitRisk = clamp(
    fragilityScore * 0.22
      + Math.max(0, 0.56 - liquidityScore) * 0.12,
    0,
    0.3,
  );
  const hedgeBoost = clamp(
    fragilityScore * 0.18
      + volatilityStress * 0.04,
    0,
    0.22,
  );
  const reasons: string[] = [];

  if (predictedState === "wall-forming") {
    reasons.push("wall_forming");
  }
  if (predictedState === "vacuum") {
    reasons.push("liquidity_vacuum_risk");
  }
  if (predictedState === "absorption-failure") {
    reasons.push("absorption_failure_risk");
  }
  if (predictedPressure !== "neutral") {
    reasons.push(`pressure_${predictedPressure}`);
  }
  if (confidence < 0.5) {
    reasons.push("low_confidence");
  }

  return {
    wallFormationProbability,
    liquidityVacuumProbability,
    absorptionFailureProbability,
    liquidityScore,
    directionalBias,
    confidence,
    predictedState,
    predictedPressure,
    entryBoost,
    earlyExitRisk,
    hedgeBoost,
    reasons,
  };
}