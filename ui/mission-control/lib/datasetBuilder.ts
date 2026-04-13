import type { SelfLearningV5Frame } from "./selfLearningV5Store";

export type ReplayDatasetRow = {
  id: string;
  features: {
    imbalance: number;
    delta: number;
    absorption: number;
    domDensity: number;
    microScore: number;
    mlProbability: number;
  };
  outcome: {
    pnl: number;
    success: boolean;
    maxDrawdown: number;
  };
};

export type ReplayDatasetSummary = {
  sampleSize: number;
  successRatePct: number;
  avgPnl: number;
  avgAbsorption: number;
  avgMicroScore: number;
  avgMlProbability: number;
};

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildDatasetFromReplayFrames(frames: SelfLearningV5Frame[]): ReplayDatasetRow[] {
  return frames.map((frame) => ({
    id: frame.id,
    features: {
      imbalance: frame.features.imbalance,
      delta: frame.features.delta,
      absorption: frame.features.absorptionProb,
      domDensity: frame.features.domDensity,
      microScore: frame.features.microScore,
      mlProbability: frame.features.mlProbability,
    },
    outcome: {
      pnl: frame.outcome.pnl,
      success: frame.outcome.success,
      maxDrawdown: frame.outcome.maxDrawdown,
    },
  }));
}

export function summarizeReplayDataset(rows: ReplayDatasetRow[]): ReplayDatasetSummary {
  const sampleSize = rows.length;
  const successRatePct = sampleSize > 0 ? (rows.filter((row) => row.outcome.success).length / sampleSize) * 100 : 0;
  return {
    sampleSize,
    successRatePct,
    avgPnl: average(rows.map((row) => row.outcome.pnl)),
    avgAbsorption: average(rows.map((row) => row.features.absorption)),
    avgMicroScore: average(rows.map((row) => row.features.microScore)),
    avgMlProbability: average(rows.map((row) => row.features.mlProbability)),
  };
}