type JsonMap = Record<string, unknown>;

import {
  buildMlFeatureVector,
  predictML as predictMlProbability,
  retrainModel as retrainMlModel,
  type MlTrainingSample,
} from "./mlDatasetBuilder";
import type { SelfLearningV5Frame } from "./selfLearningV5Store";

export type PredictorKernelTelemetry = {
  tickLatencyMs: number;
  bufferBacklog: number;
  drainedTicksPerFrame: number;
  skippedFrames: number;
  schedulerBudgetMs: number;
  schedulerPullLimit: number;
  cpuLoadHint: number;
  fpsHint: number;
  frameTimeHintMs: number;
  backlogPressure: number;
};

export type PredictorFeatureInput = {
  marketMicro: JsonMap | null;
  routingScore: JsonMap | null;
  executionTelemetry: JsonMap[];
  kernelTelemetry: PredictorKernelTelemetry;
  horizonMs: number;
  notionalUsd: number;
};

export type PredictorAssessment = {
  probability: number;
  confidence: "low" | "medium" | "high";
  featureVector: number[];
  contributions: Array<{ label: string; value: number }>;
  shouldExecute: boolean;
  threshold: number;
  horizonMs: number;
};

export type PredictorEngineV8State = {
  version: 1;
  weights: number[];
  trainedSamples: number;
  updatedAt: string | null;
};

export type PredictorEngineV8TrainingStats = {
  trainedSamples: number;
  updatedAt: string | null;
  weightShift: number;
  accuracy: number;
  retrainCount: number;
};

type TrainingSample = {
  features: number[];
  label: number;
};

const DEFAULT_THRESHOLD = 0.65;
const FEATURE_KEYS = [
  "bias",
  "spreadEdge",
  "spreadVelocity",
  "depthImbalance",
  "depthSlope",
  "cvdDelta",
  "flowImbalance",
  "tradeAggressiveness",
  "latencyPenalty",
  "venueDivergence",
  "fillQuality",
  "backlogPenalty",
  "renderPenalty",
  "notionalPressure",
  "horizonPenalty",
] as const;

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
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

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export class PredictorEngineV8 {
  private readonly initialWeights = [
    -0.2,
    1.45,
    -0.42,
    0.52,
    0.28,
    0.31,
    0.44,
    0.22,
    -0.95,
    -0.55,
    0.63,
    -0.72,
    -0.61,
    -0.26,
    -0.48,
  ];

  private weights = [...this.initialWeights];

  private readonly learningRate = 0.04;
  private trainedSamples = 0;
  private seenTelemetryIds = new Set<string>();
  private updatedAt: string | null = null;
  private lastAccuracy = 0.5;
  private retrainCount = 0;

  assess(input: PredictorFeatureInput, threshold = DEFAULT_THRESHOLD): PredictorAssessment {
    const featureVector = this.buildFeatureVector(input);
    const logit = featureVector.reduce((sum, value, index) => sum + value * this.weights[index], 0);
    const safeLogit = Number.isFinite(logit) ? logit : 0;
    const probability = sigmoid(safeLogit);
    const contributions = FEATURE_KEYS.map((label, index) => ({
      label,
      value: Number.isFinite(featureVector[index] * this.weights[index]) ? featureVector[index] * this.weights[index] : 0,
    })).sort((left, right) => Math.abs(right.value) - Math.abs(left.value)).slice(0, 5);
    return {
      probability,
      confidence: probability >= 0.76 ? "high" : probability >= 0.58 ? "medium" : "low",
      featureVector,
      contributions,
      shouldExecute: probability > threshold,
      threshold,
      horizonMs: input.horizonMs,
    };
  }

  trainFromTelemetry(items: JsonMap[]): void {
    for (const item of items) {
      const id = String(item.decision_id || item.id || item.event_id || "").trim();
      if (!id || this.seenTelemetryIds.has(id)) {
        continue;
      }
      this.seenTelemetryIds.add(id);
      const sample = this.buildTrainingSample(item);
      if (!sample) {
        continue;
      }
      this.trainSample(sample);
    }
  }

  getTrainedSamples(): number {
    return this.trainedSamples;
  }

  getState(): PredictorEngineV8State {
    return {
      version: 1,
      weights: [...this.weights],
      trainedSamples: this.trainedSamples,
      updatedAt: this.updatedAt,
    };
  }

  loadState(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") {
      return false;
    }
    const candidate = raw as Partial<PredictorEngineV8State>;
    if (!Array.isArray(candidate.weights) || candidate.weights.length !== FEATURE_KEYS.length) {
      return false;
    }
    const nextWeights = candidate.weights.map((value, index) => clamp(toNumber(value, this.initialWeights[index]), -4, 4));
    this.weights = nextWeights;
    this.trainedSamples = Math.max(0, Math.round(toNumber(candidate.trainedSamples, 0)));
    this.updatedAt = typeof candidate.updatedAt === "string" && candidate.updatedAt ? candidate.updatedAt : null;
    this.lastAccuracy = clamp(toNumber((candidate as PredictorEngineV8State & { lastAccuracy?: number }).lastAccuracy, 0.5), 0, 1);
    this.retrainCount = Math.max(0, Math.round(toNumber((candidate as PredictorEngineV8State & { retrainCount?: number }).retrainCount, 0)));
    return true;
  }

  getTrainingStats(): PredictorEngineV8TrainingStats {
    const weightShift = average(this.weights.map((weight, index) => Math.abs(weight - this.initialWeights[index])));
    return {
      trainedSamples: this.trainedSamples,
      updatedAt: this.updatedAt,
      weightShift,
      accuracy: this.lastAccuracy,
      retrainCount: this.retrainCount,
    };
  }

  predictML(features: number[]): number {
    return predictMlProbability(features, this.weights);
  }

  predictReplayFrame(frame: SelfLearningV5Frame): number {
    return this.predictML(buildMlFeatureVector(frame));
  }

  measureAccuracy(dataset: MlTrainingSample[]): number {
    if (dataset.length === 0) {
      return this.lastAccuracy;
    }
    const correct = dataset.reduce((count, sample) => {
      const prediction = this.predictML(sample.features);
      return count + (((prediction >= 0.5 ? 1 : 0) === sample.label) ? 1 : 0);
    }, 0);
    return correct / dataset.length;
  }

  retrainModel(dataset: MlTrainingSample[], epochs = 8): PredictorEngineV8TrainingStats {
    if (dataset.length === 0) {
      return this.getTrainingStats();
    }
    const result = retrainMlModel(dataset, this.weights, {
      epochs,
      learningRate: this.learningRate * 0.85,
    });
    this.weights = result.weights.map((value, index) => clamp(value, -4, 4));
    this.trainedSamples += dataset.length;
    this.lastAccuracy = result.accuracy;
    this.retrainCount += 1;
    this.updatedAt = new Date().toISOString();
    return this.getTrainingStats();
  }

  private trainSample(sample: TrainingSample): void {
    const prediction = sigmoid(sample.features.reduce((sum, value, index) => sum + value * this.weights[index], 0));
    const error = sample.label - prediction;
    this.weights = this.weights.map((weight, index) => (
      weight + this.learningRate * error * sample.features[index]
    ));
    this.trainedSamples += 1;
    this.lastAccuracy = (this.lastAccuracy * Math.min(64, Math.max(1, this.trainedSamples - 1)) + (((prediction >= 0.5 ? 1 : 0) === sample.label) ? 1 : 0))
      / Math.min(65, Math.max(2, this.trainedSamples));
    this.updatedAt = new Date().toISOString();
  }

  private buildTrainingSample(item: JsonMap): TrainingSample | null {
    const netEdgeBps = toNumber(
      item.expected_net_edge_bps ?? item.net_edge_bps ?? item.arbitrage_net_spread,
      0,
    );
    const slippageBps = Math.abs(toNumber(item.realized_slippage_bps ?? item.slippage_real_bps, 0));
    const pnlBps = toNumber(item.pnl_bps ?? item.realized_pnl_bps, netEdgeBps - slippageBps);
    const latencyMs = toNumber(item.latency_e2e_ms ?? item.latency_ms, 0);
    const fillRate = clamp(toNumber(item.fill_ratio ?? item.fill_probability ?? item.filled_ratio, 1), 0, 1);
    const notionalUsd = toNumber(item.notional_usd ?? item.estimated_notional_usd, 0);
    const horizonMs = Math.max(20, toNumber(item.prediction_horizon_ms ?? item.horizon_ms, latencyMs > 0 ? latencyMs : 50));
    const status = String(item.status ?? item.execution_status ?? "").trim().toLowerCase();
    const blocked = ["rejected", "failed", "error", "blocked", "cancelled"].includes(status);
    const hedged = Boolean(item.hedged);
    const explicitLabel = item.profitable ?? item.is_profitable ?? item.survived;

    let label: number;
    if (typeof explicitLabel === "boolean") {
      label = explicitLabel ? 1 : 0;
    } else if (typeof explicitLabel === "number") {
      label = explicitLabel > 0 ? 1 : 0;
    } else if (blocked) {
      label = 0;
    } else {
      const slippageBudgetBps = Math.max(1, netEdgeBps * 1.15 + 1.5);
      const latencyBudgetMs = Math.max(80, horizonMs * 2);
      label = pnlBps > 0
        && fillRate >= 0.55
        && slippageBps <= slippageBudgetBps
        && latencyMs <= latencyBudgetMs
        && (!hedged || pnlBps > 1)
        ? 1
        : 0;
    }

    const features = [
      1,
      clamp(netEdgeBps / 18, -2, 2),
      0,
      0,
      0,
      0,
      0,
      0,
      clamp(latencyMs / 120, 0, 3),
      0,
      clamp(fillRate * 2 - 1, -1, 1),
      0,
      0,
      clamp(notionalUsd / 10000, 0, 2),
      clamp(horizonMs / 100, 0, 2),
    ];

    return { features, label };
  }

  private buildFeatureVector(input: PredictorFeatureInput): number[] {
    const arbitrage = (input.routingScore?.arbitrage as JsonMap | undefined) || {};
    const candidates = Array.isArray(input.routingScore?.candidates)
      ? input.routingScore?.candidates as JsonMap[]
      : [];
    const spreadEdgeBps = Math.max(0, toNumber(arbitrage.net_spread, toNumber(input.marketMicro?.arbitrage_net_spread, 0)));
    const spreadVelocity = toNumber(input.marketMicro?.fusion_deviation_bps, 0) / 10;
    const depthImbalance = clamp(toNumber(input.marketMicro?.depth_imbalance, 0), -1, 1);
    const bestBid = toNumber(input.marketMicro?.best_bid ?? input.marketMicro?.fusion_best_bid, 0);
    const bestAsk = toNumber(input.marketMicro?.best_ask ?? input.marketMicro?.fusion_best_ask, 0);
    const depthSlope = bestAsk > 0 && bestBid > 0 ? clamp(((bestAsk - bestBid) / Math.max(bestAsk, bestBid)) * 2000, -2, 2) : 0;
    const cvdDelta = clamp(toNumber(input.marketMicro?.cvd_delta, 0) / 5000, -2, 2);
    const flowImbalance = clamp(toNumber(input.marketMicro?.flow_imbalance, 0), -1.5, 1.5);
    const tradeAggressiveness = clamp(toNumber(input.marketMicro?.trade_aggressiveness, 0), -1.5, 1.5);
    const latencyPenalty = clamp(
      Math.max(input.kernelTelemetry.tickLatencyMs, toNumber(input.marketMicro?.avg_latency_ms, 0), toNumber(input.executionTelemetry[0]?.latency_e2e_ms, 0)) / 90,
      0,
      3,
    );
    const candidateSpreads = candidates
      .map((candidate) => toNumber(candidate.spread_bps, 0))
      .filter((value) => value > 0)
      .sort((left, right) => left - right);
    const venueDivergence = candidateSpreads.length >= 2
      ? clamp((candidateSpreads[candidateSpreads.length - 1] - candidateSpreads[0]) / 12, 0, 2.5)
      : 0;
    const recentFillQuality = (() => {
      const recent = input.executionTelemetry.slice(0, 8);
      if (recent.length === 0) {
        return 0;
      }
      const fillRate = average(recent.map((item) => clamp(toNumber(item.fill_ratio ?? item.fill_probability, 1), 0, 1)));
      const slippage = average(recent.map((item) => Math.abs(toNumber(item.realized_slippage_bps ?? item.slippage_real_bps, 0))));
      return clamp(fillRate - slippage / 20, -1, 1);
    })();
    const backlogPenalty = clamp(input.kernelTelemetry.backlogPressure / 2.5, 0, 2.5);
    const renderPenalty = clamp(
      ((Math.max(16.7, input.kernelTelemetry.frameTimeHintMs) - 16.7) / 4.8)
      + Math.max(0, 55 - input.kernelTelemetry.fpsHint) / 22
      + Math.max(0, input.kernelTelemetry.cpuLoadHint - 1),
      0,
      3,
    );
    const notionalPressure = clamp(input.notionalUsd / 15000, 0, 2.5);
    const horizonPenalty = clamp((input.horizonMs - 20) / 80, 0, 1.25);

    return [
      1,
      clamp(spreadEdgeBps / 18, -2, 2.5),
      clamp(spreadVelocity, -2, 2),
      depthImbalance,
      depthSlope,
      cvdDelta,
      flowImbalance,
      tradeAggressiveness,
      latencyPenalty,
      venueDivergence,
      recentFillQuality,
      backlogPenalty,
      renderPenalty,
      notionalPressure,
      horizonPenalty,
    ];
  }
}