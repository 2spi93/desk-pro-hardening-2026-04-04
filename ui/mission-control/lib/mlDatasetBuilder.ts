import type { SelfLearningV5Frame } from "./selfLearningV5Store";

export type MlTrainingSample = {
  id: string;
  features: number[];
  label: number;
};

export type MlRetrainResult = {
  weights: number[];
  accuracy: number;
  loss: number;
  epochs: number;
};

const FEATURE_VECTOR_LENGTH = 15;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function padFeatures(features: number[], length: number): number[] {
  if (features.length === length) {
    return features;
  }
  if (features.length > length) {
    return features.slice(0, length);
  }
  return [...features, ...Array.from({ length: length - features.length }, () => 0)];
}

export function buildMlFeatureVector(frame: SelfLearningV5Frame): number[] {
  const liquidityEdge = frame.features.liquidityWall - frame.features.liquidityVacuum;
  const spreadPenalty = clamp(frame.context.spread / 20, 0, 3);
  const volatilityPenalty = clamp(frame.context.volatility / 110, 0, 3);
  const deltaVelocity = clamp(frame.features.delta / 2200, -2, 2);
  const depthSlope = clamp(frame.features.domDensity * 2 - 1, -1, 1);
  const quality = clamp(
    frame.features.microScore * 0.42
      + frame.features.absorptionProb * 0.34
      + Math.max(0, liquidityEdge) * 0.24,
    0,
    1,
  );
  return [
    1,
    clamp((frame.features.microScore * 1.2 + liquidityEdge * 0.9) - spreadPenalty * 0.18, -2, 2),
    deltaVelocity,
    clamp(frame.features.imbalance, -1, 1),
    depthSlope,
    clamp(frame.features.delta / 2600, -2, 2),
    clamp(frame.features.imbalance * (0.82 + frame.features.absorptionProb * 0.18), -1, 1),
    clamp(frame.features.absorptionProb * 2 - 1 - frame.features.spoofingRisk * 0.55, -1, 1),
    spreadPenalty,
    clamp(volatilityPenalty + frame.features.spoofingRisk * 0.5, 0, 3),
    clamp(quality * 2 - 1, -1, 1),
    clamp(frame.features.spoofingRisk * 1.2 + frame.features.liquidityVacuum * 0.9, 0, 3),
    clamp(volatilityPenalty + spreadPenalty * 0.18, 0, 3),
    clamp(frame.context.volatility / 140 + Math.abs(frame.features.delta) / 4500, 0, 2),
    clamp(frame.context.spread / 45 + frame.context.volatility / 200, 0, 2),
  ];
}

export function buildDataset(frames: SelfLearningV5Frame[]): MlTrainingSample[] {
  return frames
    .filter((frame) => Number.isFinite(frame.outcome.pnl) || typeof frame.outcome.success === "boolean")
    .map((frame) => ({
      id: frame.id,
      features: buildMlFeatureVector(frame),
      label: frame.outcome.success || frame.outcome.pnl > 0 ? 1 : 0,
    }));
}

export function predictML(features: number[], weights: number[]): number {
  const safeFeatures = padFeatures(features, weights.length);
  const logit = safeFeatures.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0);
  return sigmoid(Number.isFinite(logit) ? logit : 0);
}

export function retrainModel(
  dataset: MlTrainingSample[],
  initialWeights: number[],
  options?: { epochs?: number; learningRate?: number },
): MlRetrainResult {
  const epochs = Math.max(1, Math.round(options?.epochs ?? 8));
  const learningRate = clamp(options?.learningRate ?? 0.035, 0.001, 0.2);
  if (dataset.length === 0) {
    return {
      weights: [...initialWeights],
      accuracy: 0.5,
      loss: 0,
      epochs,
    };
  }

  let weights = [...initialWeights];
  let accuracy = 0.5;
  let loss = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = new Array(weights.length).fill(0);
    let epochLoss = 0;
    let correct = 0;

    for (const sample of dataset) {
      const features = padFeatures(sample.features, weights.length);
      const prediction = predictML(features, weights);
      const error = prediction - sample.label;
      for (let index = 0; index < weights.length; index += 1) {
        gradient[index] += error * features[index];
      }
      const clippedPrediction = clamp(prediction, 0.000001, 0.999999);
      epochLoss += -(sample.label * Math.log(clippedPrediction) + (1 - sample.label) * Math.log(1 - clippedPrediction));
      if ((prediction >= 0.5 ? 1 : 0) === sample.label) {
        correct += 1;
      }
    }

    weights = weights.map((weight, index) => weight - learningRate * (gradient[index] / dataset.length));
    accuracy = correct / dataset.length;
    loss = epochLoss / dataset.length;
  }

  return {
    weights,
    accuracy,
    loss,
    epochs,
  };
}