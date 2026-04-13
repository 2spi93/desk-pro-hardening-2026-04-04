import type { SelfLearningV5Frame } from "./selfLearningV5Store";

export type MiroFishDirection = "LONG" | "SHORT" | "NEUTRAL";

export type MiroFishContext = {
  imbalance: number;
  absorptionProb: number;
  microScore: number;
  mlProb: number;
  volatility: number;
  drawdown: number;
  liquidityScore: number;
  domDensity: number;
  spreadBps: number;
};

export type MiroFishAgentAction = {
  agentType: string;
  bias: number;
  risk: number;
  confidence: number;
};

export type MiroFishSimulationResult = {
  predictedDirection: MiroFishDirection;
  confidence: number;
  normalizedBias: number;
  consensusScore: number;
  blocker: string | null;
  agents: MiroFishAgentAction[];
};

export type MiroFishStrategyCandidate = {
  swarmConfidence: number;
  swarmDirection: MiroFishDirection;
  absorptionThresholdBias: number;
  imbalanceWeightBias: number;
  domWeightBias: number;
  liquidityWeightBias: number;
  microScoreFloorBias: number;
  mlProbabilityFloorBias: number;
};

export type MiroFishFusionInput = {
  microScore: number;
  miroConfidence: number;
  mlProbability: number;
  miroFlashBoost?: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

class BaseAgent {
  readonly type: string;

  constructor(type: string) {
    this.type = type;
  }

  act(_context: MiroFishContext): MiroFishAgentAction {
    return {
      agentType: this.type,
      bias: 0,
      risk: 0.5,
      confidence: 0.5,
    };
  }
}

class RetailAgent extends BaseAgent {
  constructor() {
    super("retail");
  }

  act(context: MiroFishContext): MiroFishAgentAction {
    const momentumBias = clamp(context.imbalance * 0.55 + (context.mlProb - 0.5) * 0.45, -1, 1);
    const risk = clamp(0.68 + context.volatility * 0.16 + context.spreadBps * 0.002, 0.2, 0.95);
    return {
      agentType: this.type,
      bias: momentumBias,
      risk,
      confidence: clamp(0.42 + Math.abs(momentumBias) * 0.32, 0.2, 0.92),
    };
  }
}

class WhaleAgent extends BaseAgent {
  constructor() {
    super("whale");
  }

  act(context: MiroFishContext): MiroFishAgentAction {
    const bias = clamp(
      context.imbalance * 1.35
      + (context.absorptionProb - 0.5) * 0.9
      + (context.microScore - 0.5) * 0.75,
      -1.5,
      1.5,
    );
    const risk = clamp(0.24 + context.drawdown * 1.5 + context.volatility * 0.12, 0.1, 0.7);
    return {
      agentType: this.type,
      bias,
      risk,
      confidence: clamp(0.55 + Math.abs(bias) * 0.22 + context.absorptionProb * 0.1, 0.25, 0.96),
    };
  }
}

class MarketMakerAgent extends BaseAgent {
  constructor() {
    super("market-maker");
  }

  act(context: MiroFishContext): MiroFishAgentAction {
    const meanReversionBias = clamp(
      -context.imbalance * 0.5
      + (context.liquidityScore - 0.5) * 0.4
      - (context.spreadBps > 10 ? 0.12 : 0),
      -1,
      1,
    );
    const risk = clamp(0.18 + context.volatility * 0.08 + Math.max(0, 0.5 - context.liquidityScore) * 0.25, 0.08, 0.55);
    return {
      agentType: this.type,
      bias: meanReversionBias,
      risk,
      confidence: clamp(0.52 + context.liquidityScore * 0.2 + context.domDensity * 0.14, 0.25, 0.94),
    };
  }
}

function aggregate(results: MiroFishAgentAction[]): MiroFishSimulationResult {
  if (!results.length) {
    return {
      predictedDirection: "NEUTRAL",
      confidence: 0,
      normalizedBias: 0,
      consensusScore: 0,
      blocker: "NO_AGENTS",
      agents: [],
    };
  }

  let weightedBias = 0;
  let totalConfidence = 0;
  let inverseRisk = 0;
  for (const result of results) {
    weightedBias += result.bias * result.confidence;
    totalConfidence += result.confidence;
    inverseRisk += 1 - result.risk;
  }

  const normalizedBias = totalConfidence > 0 ? weightedBias / totalConfidence : 0;
  const averageConfidence = totalConfidence / results.length;
  const consensusScore = inverseRisk / results.length;
  const confidence = clamp(averageConfidence * 0.55 + consensusScore * 0.45 + Math.min(0.15, Math.abs(normalizedBias) * 0.1), 0, 1);
  const predictedDirection: MiroFishDirection = normalizedBias > 0.05 ? "LONG" : normalizedBias < -0.05 ? "SHORT" : "NEUTRAL";
  return {
    predictedDirection,
    confidence,
    normalizedBias: clamp(normalizedBias, -1.5, 1.5),
    consensusScore: clamp(consensusScore, 0, 1),
    blocker: confidence < 0.4 ? "LOW_SWARM_CONFIDENCE" : null,
    agents: results,
  };
}

export function runMiroFishSimulation(context: MiroFishContext): MiroFishSimulationResult {
  const agents = [
    new RetailAgent(),
    new WhaleAgent(),
    new MarketMakerAgent(),
  ];
  const results = agents.map((agent) => agent.act(context));
  return aggregate(results);
}

export function buildMiroFishContextFromFrame(frame: SelfLearningV5Frame): MiroFishContext {
  return {
    imbalance: clamp(frame.features.imbalance, -1, 1),
    absorptionProb: clamp(frame.features.absorptionProb, 0, 1),
    microScore: clamp(frame.features.microScore, 0, 1),
    mlProb: clamp(frame.features.mlProbability, 0, 1),
    volatility: Math.max(0, frame.context.volatility),
    drawdown: Math.max(0, Math.abs(frame.outcome.maxDrawdown) / 100),
    liquidityScore: clamp(frame.features.liquidityWall - frame.features.liquidityVacuum * 0.5, 0, 1),
    domDensity: clamp(frame.features.domDensity, 0, 1),
    spreadBps: Math.max(0, frame.context.spread),
  };
}

export function buildMiroFishContextFromFrames(frames: SelfLearningV5Frame[]): MiroFishContext {
  if (!frames.length) {
    return {
      imbalance: 0,
      absorptionProb: 0,
      microScore: 0,
      mlProb: 0,
      volatility: 0,
      drawdown: 0,
      liquidityScore: 0,
      domDensity: 0,
      spreadBps: 0,
    };
  }
  const count = frames.length;
  const totals = frames.reduce((accumulator, frame) => {
    accumulator.imbalance += frame.features.imbalance;
    accumulator.absorptionProb += frame.features.absorptionProb;
    accumulator.microScore += frame.features.microScore;
    accumulator.mlProb += frame.features.mlProbability;
    accumulator.volatility += frame.context.volatility;
    accumulator.drawdown += Math.abs(frame.outcome.maxDrawdown) / 100;
    accumulator.liquidityScore += frame.features.liquidityWall - frame.features.liquidityVacuum * 0.5;
    accumulator.domDensity += frame.features.domDensity;
    accumulator.spreadBps += frame.context.spread;
    return accumulator;
  }, {
    imbalance: 0,
    absorptionProb: 0,
    microScore: 0,
    mlProb: 0,
    volatility: 0,
    drawdown: 0,
    liquidityScore: 0,
    domDensity: 0,
    spreadBps: 0,
  });

  return {
    imbalance: clamp(totals.imbalance / count, -1, 1),
    absorptionProb: clamp(totals.absorptionProb / count, 0, 1),
    microScore: clamp(totals.microScore / count, 0, 1),
    mlProb: clamp(totals.mlProb / count, 0, 1),
    volatility: Math.max(0, totals.volatility / count),
    drawdown: clamp(totals.drawdown / count, 0, 1),
    liquidityScore: clamp(totals.liquidityScore / count, 0, 1),
    domDensity: clamp(totals.domDensity / count, 0, 1),
    spreadBps: Math.max(0, totals.spreadBps / count),
  };
}

export function generateMiroFishCandidates(context: MiroFishContext, count = 8): MiroFishStrategyCandidate[] {
  const simulation = runMiroFishSimulation(context);
  const directionBias = simulation.predictedDirection === "LONG" ? 1 : simulation.predictedDirection === "SHORT" ? -1 : 0;
  const candidates: MiroFishStrategyCandidate[] = [];
  const safeCount = Math.max(1, Math.min(16, Math.floor(count)));

  for (let index = 0; index < safeCount; index += 1) {
    const step = index / Math.max(1, safeCount - 1);
    const confidenceScale = simulation.confidence * (0.8 + step * 0.35);
    candidates.push({
      swarmConfidence: clamp(confidenceScale, 0, 1),
      swarmDirection: simulation.predictedDirection,
      absorptionThresholdBias: clamp(-0.05 * simulation.confidence, -0.08, 0.02),
      imbalanceWeightBias: clamp(directionBias * 0.02 * (0.5 + step), -0.05, 0.05),
      domWeightBias: clamp((simulation.consensusScore - 0.5) * 0.06, -0.05, 0.05),
      liquidityWeightBias: clamp((context.liquidityScore - 0.5) * 0.08, -0.05, 0.05),
      microScoreFloorBias: clamp(-0.04 * simulation.confidence, -0.08, 0.03),
      mlProbabilityFloorBias: clamp(-0.06 * simulation.confidence, -0.08, 0.03),
    });
  }

  return candidates;
}

export function computeMiroFishFusionScore(input: MiroFishFusionInput): number {
  const miroFlashBoost = clamp(input.miroFlashBoost ?? 0, 0, 0.3);
  return clamp(
    input.microScore * 0.5
    + input.miroConfidence * 0.3
    + input.mlProbability * 0.2
    + miroFlashBoost,
    0,
    1,
  );
}