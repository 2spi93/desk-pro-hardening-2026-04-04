import type {
  SelfLearningV5CycleSummary,
  SelfLearningV5Frame,
  SelfLearningV5PromotionAudit,
  SelfLearningV5RegistryEntry,
  SelfLearningV5RegistryObservation,
  SelfLearningV5State,
  SelfLearningV5StrategyParams,
} from "./selfLearningV5Store";
import { buildDatasetFromReplayFrames, summarizeReplayDataset } from "./datasetBuilder";
import {
  buildMiroFishContextFromFrame,
  buildMiroFishContextFromFrames,
  computeMiroFishFusionScore,
  generateMiroFishCandidates,
  runMiroFishSimulation,
} from "./mirofishLite";

type JsonRecord = Record<string, unknown>;

export type MetaHarnessSafeInput = {
  accountId: string;
  symbol: string;
  timeframe: string;
  enabled?: boolean;
  strictValidation?: boolean;
  allowLiveDeployment?: boolean;
  outcomes?: unknown[];
  replayPayloads?: unknown[];
  strategyPerformance?: unknown[];
  marketContext?: Record<string, unknown> | null;
  portfolioRisk?: Record<string, unknown> | null;
  microAlpha?: Record<string, unknown> | null;
  previousState?: SelfLearningV5State | null;
};

export type SelfLearningV5FrameEvaluation = {
  pass: boolean;
  blockers: string[];
  combinedSignal: number;
  absorptionSignal: number;
  microSignal: number;
  mlSignal: number;
  imbalanceSignal: number;
  domSignal: number;
  liquiditySignal: number;
  swarmConfidence: number;
  swarmDirection: string;
  fusionScore: number;
};

export type SelfLearningV5PromotionReadiness = SelfLearningV5RegistryObservation;

export const SELF_LEARNING_V5_PROMOTION_THRESHOLDS = {
  requiredShadowCycles: 3,
  requiredObservationHours: 6,
} as const;

type VariantMetrics = {
  trades: number;
  winratePct: number;
  avgPnl: number;
  drawdownPct: number;
  sharpe: number;
  overfitGapPct: number;
  score: number;
};

type VariantEvaluation = {
  entry: SelfLearningV5RegistryEntry;
  score: number;
};

const DEFAULT_THRESHOLDS = {
  minWinratePct: 55,
  maxDrawdownPct: 8,
  minSharpe: 1.2,
  maxOverfitGapPct: 12,
  minTrades: 12,
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function pickPathNumber(source: JsonRecord, paths: string[], fallback = 0): number {
  for (const path of paths) {
    const parts = path.split(".");
    let cursor: unknown = source;
    let failed = false;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || !(part in (cursor as JsonRecord))) {
        failed = true;
        break;
      }
      cursor = (cursor as JsonRecord)[part];
    }
    if (!failed) {
      const numeric = toNumber(cursor, Number.NaN);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
  }
  return fallback;
}

function pickPathString(source: JsonRecord, paths: string[], fallback = ""): string {
  for (const path of paths) {
    const parts = path.split(".");
    let cursor: unknown = source;
    let failed = false;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || !(part in (cursor as JsonRecord))) {
        failed = true;
        break;
      }
      cursor = (cursor as JsonRecord)[part];
    }
    if (!failed && cursor != null) {
      const text = String(cursor).trim();
      if (text) {
        return text;
      }
    }
  }
  return fallback;
}

function pickPathBoolean(source: JsonRecord, paths: string[], fallback = false): boolean {
  for (const path of paths) {
    const parts = path.split(".");
    let cursor: unknown = source;
    let failed = false;
    for (const part of parts) {
      if (!cursor || typeof cursor !== "object" || !(part in (cursor as JsonRecord))) {
        failed = true;
        break;
      }
      cursor = (cursor as JsonRecord)[part];
    }
    if (!failed) {
      return toBoolean(cursor, fallback);
    }
  }
  return fallback;
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map((value) => Math.pow(value - mean, 2)));
  return Math.sqrt(variance);
}

function maxDrawdownPct(values: number[]): number {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }
  return maxDrawdown;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function replayPayloadMap(replayPayloads: unknown[]): Map<string, JsonRecord> {
  const mapped = new Map<string, JsonRecord>();
  for (const item of replayPayloads) {
    const record = toRecord(item);
    const payload = toRecord(record.payload ?? item);
    const decisionId = pickPathString(payload, ["decision_id", "decisionId"], pickPathString(record, ["decision_id", "decisionId"], ""));
    if (decisionId) {
      mapped.set(decisionId, payload);
    }
  }
  return mapped;
}

function buildFrameFromSources(params: {
  item: JsonRecord;
  replay: JsonRecord;
  marketContext: JsonRecord;
  microAlpha: JsonRecord;
  index: number;
}): SelfLearningV5Frame {
  const { item, replay, marketContext, microAlpha, index } = params;
  const telemetry = toRecord(replay.telemetry);
  const telemetryPayload = toRecord(telemetry.payload);
  const predictorPayload = toRecord(telemetryPayload.predictor);
  const brainReplay = toRecord(replay.brain_replay);
  const kairosHarness = toRecord(replay.kairos_harness);
  const preTradeMemoryGate = toRecord(replay.pre_trade_memory_gate);
  const fillCount = Array.isArray(replay.fills) ? replay.fills.length : 0;
  const strategyId = pickPathString(item, ["strategy_id", "strategyId"], pickPathString(telemetryPayload, ["strategy_id", "strategyId"], "unknown"));
  const timestampIso = pickPathString(
    item,
    ["timestamp", "timestamp_iso", "closed_at", "filled_at", "created_at"],
    pickPathString(telemetry, ["ts_fill_final", "ts_fill_partial", "ts_routing", "created_at"], new Date().toISOString()),
  );
  const pnl = pickPathNumber(item, ["pnl_usd", "pnlUsd", "outcome.pnl", "telemetry.pnl_usd"], 0);
  const pnlPct = pickPathNumber(item, ["pnl_pct", "pnlPct", "outcome.pnl_pct"], pnl === 0 ? 0 : pnl / 100);
  const maxDrawdown = Math.abs(pickPathNumber(item, ["max_drawdown_pct", "maxDrawdownPct", "mae_pct", "mae", "mae_bps"], 0));
  const success = toBoolean(item.success, pnl > 0);
  const trend = pickPathString(
    brainReplay,
    ["trend", "direction", "regime"],
    pickPathString(item, ["trend", "regime", "market_regime"], pickPathString(marketContext, ["trend", "regime"], "flat")),
  );
  const regime = pickPathString(
    brainReplay,
    ["regime"],
    pickPathString(predictorPayload, ["regime"], pickPathString(item, ["regime", "market_regime"], pickPathString(marketContext, ["regime"], "unknown"))),
  );
  const spread = pickPathNumber(
    telemetry,
    ["quote_spread_bps"],
    pickPathNumber(item, ["spread_bps", "spreadBps", "telemetry.spread_bps"], pickPathNumber(marketContext, ["spreadBps", "spread"], 0)),
  );
  const volatility = pickPathNumber(
    predictorPayload,
    ["volatility_bps", "fusion_deviation_bps"],
    pickPathNumber(item, ["volatility", "realized_volatility", "telemetry.volatility"], pickPathNumber(marketContext, ["volatility"], 0)),
  );

  return {
    id: pickPathString(item, ["decision_id", "decisionId"], `${strategyId}-${index}-${timestampIso}`),
    timestampIso,
    features: {
      absorptionProb: pickPathNumber(
        predictorPayload,
        ["absorption_prob", "absorptionProb"],
        pickPathNumber(item, ["absorption_prob", "absorptionProb", "predictor_payload.absorption_prob", "telemetry.absorption_prob"], toNumber(microAlpha.absorptionProb, 0)),
      ),
      imbalance: pickPathNumber(
        predictorPayload,
        ["imbalance", "flow_imbalance", "flowImbalance", "synthetic_orderflow.imbalance", "syntheticOrderflow.imbalance"],
        pickPathNumber(item, ["imbalance", "flow_imbalance", "telemetry.flow_imbalance", "predictor_payload.imbalance", "synthetic_orderflow.imbalance"], toNumber((microAlpha as JsonRecord).effectiveImbalance, 0)),
      ),
      delta: pickPathNumber(
        predictorPayload,
        ["delta", "cvd_delta", "cvdDelta", "synthetic_orderflow.delta", "syntheticOrderflow.delta"],
        pickPathNumber(item, ["delta", "cvdDelta", "telemetry.delta", "predictor_payload.delta", "synthetic_orderflow.delta"], toNumber((microAlpha as JsonRecord).effectiveDelta, 0)),
      ),
      domDensity: pickPathNumber(
        predictorPayload,
        ["dom_density", "domDensity", "synthetic_orderflow.dom_density", "syntheticOrderflow.domDensity"],
        pickPathNumber(item, ["dom_density", "domDensity", "telemetry.dom_density", "synthetic_orderflow.dom_density"], toNumber((microAlpha as JsonRecord).domDensity, 0)),
      ),
      liquidityWall: pickPathNumber(
        predictorPayload,
        ["liquidity_wall", "liquidityWall"],
        pickPathNumber(kairosHarness, ["liquidity_wall", "support_wall", "resistance_wall"], pickPathBoolean(preTradeMemoryGate, ["liquidity_wall", "liquidityWall"], false) ? 1 : toNumber(microAlpha.liquidityWall, 0)),
      ),
      liquidityVacuum: pickPathNumber(
        predictorPayload,
        ["liquidity_vacuum", "liquidityVacuum"],
        pickPathNumber(kairosHarness, ["liquidity_vacuum", "vacuum_score"], pickPathBoolean(preTradeMemoryGate, ["liquidity_vacuum", "liquidityVacuum"], false) ? 1 : toNumber(microAlpha.liquidityVacuum, 0)),
      ),
      microScore: pickPathNumber(
        predictorPayload,
        ["micro_score", "microScore"],
        pickPathNumber(item, ["micro_score", "microScore", "predictor_payload.micro_score", "telemetry.micro_score"], toNumber((microAlpha as JsonRecord).effectiveMicroScore, toNumber(microAlpha.microScore, 0))),
      ),
      spoofingRisk: pickPathNumber(
        predictorPayload,
        ["spoofing_risk", "spoofingRisk"],
        pickPathNumber(item, ["spoofing_risk", "spoofingRisk", "telemetry.spoofing_risk"], toNumber(microAlpha.spoofingRisk, 0)),
      ),
      mlProbability: pickPathNumber(
        predictorPayload,
        ["success_probability", "ml_probability", "mlProbability", "confidence"],
        pickPathNumber(brainReplay, ["confidence", "score"], pickPathNumber(item, ["ml_probability", "mlProbability", "predictor_payload.ml_probability", "predictor_payload.success_probability"], toNumber(microAlpha.confidence, 0))),
      ),
    },
    context: {
      trend,
      volatility,
      spread,
      regime,
    },
    outcome: {
      pnl: pnl !== 0 ? pnl : pnlPct,
      maxDrawdown,
      success,
    },
    source: {
      strategyId,
      executionMode: pickPathString(item, ["mode", "execution_mode", "source.mode"], fillCount > 0 ? "live-replay" : "replay"),
    },
  };
}

export function evaluateSelfLearningV5Frame(frame: SelfLearningV5Frame, params: SelfLearningV5StrategyParams): SelfLearningV5FrameEvaluation {
  const blockers: string[] = [];
  const absorptionSignal = frame.features.absorptionProb;
  const microSignal = frame.features.microScore;
  const mlSignal = frame.features.mlProbability;
  const weightedMlSignal = Math.max(-0.18, (mlSignal - 0.5) * 2 * params.mlWeight);
  const imbalanceSignal = Math.abs(frame.features.imbalance) * params.imbalanceWeight;
  const domSignal = frame.features.domDensity * params.domWeight;
  const liquiditySignal = (frame.features.liquidityWall - frame.features.liquidityVacuum) * params.liquidityWeight;
  const miroFish = runMiroFishSimulation(buildMiroFishContextFromFrame(frame));
  const fusionScore = computeMiroFishFusionScore({
    microScore: microSignal,
    miroConfidence: miroFish.confidence,
    mlProbability: mlSignal,
    miroFlashBoost: absorptionSignal >= Math.max(0.82, params.absorptionThreshold) && Math.abs(frame.features.imbalance) >= 0.22 ? 0.08 : 0,
  });
  const imbalanceDirection = frame.features.imbalance > 0.05 ? "LONG" : frame.features.imbalance < -0.05 ? "SHORT" : "NEUTRAL";
  const swarmAlignment = imbalanceDirection === "NEUTRAL" || miroFish.predictedDirection === "NEUTRAL"
    ? 0
    : imbalanceDirection === miroFish.predictedDirection
      ? 1
      : -1;
  const swarmInfluence = swarmAlignment * miroFish.confidence * (0.08 + Math.abs(frame.features.imbalance) * 0.12 + mlSignal * 0.08);
  const swarmPenalty = Math.max(0, 0.38 - miroFish.confidence) * 0.18 + (swarmAlignment < 0 ? miroFish.confidence * 0.08 : 0);
  const combinedSignal = imbalanceSignal + domSignal + liquiditySignal + weightedMlSignal + Math.max(-0.2, (fusionScore - 0.5) * 0.7) + swarmInfluence - swarmPenalty;

  if (absorptionSignal < params.absorptionThreshold) blockers.push("absorption_below_threshold");
  if (microSignal < params.microScoreFloor) blockers.push("micro_score_below_floor");
  if (mlSignal < params.mlProbabilityFloor) blockers.push("ml_probability_below_floor");
  if (combinedSignal < 0.15) blockers.push("combined_signal_below_floor");

  return {
    pass: blockers.length === 0,
    blockers,
    combinedSignal,
    absorptionSignal,
    microSignal,
    mlSignal,
    imbalanceSignal,
    domSignal,
    liquiditySignal,
    swarmConfidence: miroFish.confidence,
    swarmDirection: miroFish.predictedDirection,
    fusionScore,
  };
}

function buildReplayDataset(input: MetaHarnessSafeInput): SelfLearningV5Frame[] {
  const rows = Array.isArray(input.outcomes) ? input.outcomes : [];
  const marketContext = input.marketContext && typeof input.marketContext === "object" ? input.marketContext : {};
  const microAlpha = input.microAlpha && typeof input.microAlpha === "object" ? input.microAlpha : {};
  const replayMap = replayPayloadMap(Array.isArray(input.replayPayloads) ? input.replayPayloads : []);
  const frames: SelfLearningV5Frame[] = [];

  rows.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const row = item as JsonRecord;
    const decisionId = pickPathString(row, ["decision_id", "decisionId"], "");
    const replay = replayMap.get(decisionId) || {};
    frames.push(buildFrameFromSources({
      item: row,
      replay,
      marketContext: marketContext as JsonRecord,
      microAlpha: microAlpha as JsonRecord,
      index,
    }));
  });

  return frames
    .sort((left, right) => Date.parse(left.timestampIso) - Date.parse(right.timestampIso))
    .slice(-240);
}

function buildBaseParams(input: MetaHarnessSafeInput): SelfLearningV5StrategyParams {
  const microAlpha = input.microAlpha && typeof input.microAlpha === "object" ? input.microAlpha : {};
  const liquidityAccuracy = clamp(toNumber(microAlpha.liquidityAccuracy, 0.65), 0, 1);
  const mlAccuracy = clamp(toNumber(microAlpha.mlAccuracy, 0.6), 0, 1);
  const liquidityWeight = liquidityAccuracy < 0.55
    ? clamp(0.15 - (0.55 - liquidityAccuracy) * 0.22, 0.08, 0.15)
    : clamp(0.15 + (liquidityAccuracy - 0.55) * 0.14, 0.15, 0.22);
  const mlWeight = mlAccuracy < 0.55
    ? clamp(0.2 - (0.55 - mlAccuracy) * 0.32, 0.1, 0.2)
    : mlAccuracy > 0.65
      ? clamp(0.2 + (mlAccuracy - 0.65) * 0.28, 0.2, 0.3)
      : 0.2;
  return {
    absorptionThreshold: Math.max(0.55, Math.min(0.95, toNumber(microAlpha.absorptionProb, 0.8))),
    imbalanceWeight: 0.25,
    domWeight: 0.2,
    liquidityWeight,
    mlWeight,
    microScoreFloor: Math.max(0.55, Math.min(0.95, toNumber(microAlpha.microScore, 0.75))),
    mlProbabilityFloor: Math.max(0.5, Math.min(0.95, toNumber(microAlpha.confidence, 0.7))),
  };
}

function generateVariants(base: SelfLearningV5StrategyParams, frames: SelfLearningV5Frame[]): SelfLearningV5StrategyParams[] {
  const seededVariants: SelfLearningV5StrategyParams[] = [];
  const absorptionOffsets = [-0.08, -0.04, 0, 0.04, 0.08];
  const microOffsets = [-0.08, -0.03, 0.03, 0.08];
  const mlOffsets = [-0.08, -0.03, 0.03, 0.08];
  const weightSets = [
    { imbalanceWeight: 0.22, domWeight: 0.18, liquidityWeight: clamp(base.liquidityWeight - 0.02, 0.08, 0.24), mlWeight: clamp(base.mlWeight - 0.03, 0.1, 0.3) },
    { imbalanceWeight: 0.25, domWeight: 0.2, liquidityWeight: clamp(base.liquidityWeight, 0.08, 0.26), mlWeight: clamp(base.mlWeight, 0.1, 0.32) },
    { imbalanceWeight: 0.3, domWeight: 0.24, liquidityWeight: clamp(base.liquidityWeight + 0.03, 0.1, 0.28), mlWeight: clamp(base.mlWeight + 0.04, 0.12, 0.34) },
  ];

  for (const absorptionOffset of absorptionOffsets) {
    for (const microOffset of microOffsets) {
      for (const mlOffset of mlOffsets) {
        for (const weightSet of weightSets) {
          seededVariants.push({
            absorptionThreshold: Math.max(0.55, Math.min(0.95, base.absorptionThreshold + absorptionOffset)),
            imbalanceWeight: weightSet.imbalanceWeight,
            domWeight: weightSet.domWeight,
            liquidityWeight: weightSet.liquidityWeight,
            mlWeight: weightSet.mlWeight,
            microScoreFloor: Math.max(0.5, Math.min(0.95, base.microScoreFloor + microOffset)),
            mlProbabilityFloor: Math.max(0.45, Math.min(0.95, base.mlProbabilityFloor + mlOffset)),
          });
          if (seededVariants.length >= 72) {
            break;
          }
        }
      }
    }
  }

  const miroContext = buildMiroFishContextFromFrames(frames.slice(-48));
  const miroCandidates = generateMiroFishCandidates(miroContext, 12);
  const adjustedVariants = miroCandidates.map((candidate, index) => {
    const seed = seededVariants[index % Math.max(1, seededVariants.length)] || base;
    const directionBias = candidate.swarmDirection === "LONG" ? 1 : candidate.swarmDirection === "SHORT" ? -1 : 0;
    return {
      absorptionThreshold: clamp(seed.absorptionThreshold + candidate.absorptionThresholdBias, 0.55, 0.95),
      imbalanceWeight: clamp(seed.imbalanceWeight + candidate.imbalanceWeightBias, 0.18, 0.4),
      domWeight: clamp(seed.domWeight + candidate.domWeightBias, 0.14, 0.34),
      liquidityWeight: clamp(seed.liquidityWeight + candidate.liquidityWeightBias + directionBias * 0.01, 0.1, 0.28),
      mlWeight: clamp(seed.mlWeight + candidate.mlProbabilityFloorBias * 0.45, 0.1, 0.34),
      microScoreFloor: clamp(seed.microScoreFloor + candidate.microScoreFloorBias, 0.48, 0.95),
      mlProbabilityFloor: clamp(seed.mlProbabilityFloor + candidate.mlProbabilityFloorBias, 0.45, 0.95),
    };
  });

  const deduped = new Map<string, SelfLearningV5StrategyParams>();
  for (const variant of [...adjustedVariants, ...seededVariants]) {
    const key = [
      variant.absorptionThreshold.toFixed(4),
      variant.imbalanceWeight.toFixed(4),
      variant.domWeight.toFixed(4),
      variant.liquidityWeight.toFixed(4),
      variant.mlWeight.toFixed(4),
      variant.microScoreFloor.toFixed(4),
      variant.mlProbabilityFloor.toFixed(4),
    ].join(":");
    if (!deduped.has(key)) {
      deduped.set(key, variant);
    }
    if (deduped.size >= 72) {
      break;
    }
  }
  return [...deduped.values()];
}

function evaluateSlice(frames: SelfLearningV5Frame[], params: SelfLearningV5StrategyParams): VariantMetrics {
  const selected = frames.filter((frame) => evaluateSelfLearningV5Frame(frame, params).pass);

  const pnlSeries = selected.map((frame) => frame.outcome.pnl);
  const trades = selected.length;
  const winratePct = trades > 0 ? (selected.filter((frame) => frame.outcome.success).length / trades) * 100 : 0;
  const avgPnl = trades > 0 ? average(pnlSeries) : 0;
  const sharpeBase = standardDeviation(pnlSeries);
  const sharpe = trades > 1 && sharpeBase > 0 ? avgPnl / sharpeBase : 0;
  const drawdownPct = maxDrawdownPct(pnlSeries.map((value) => Math.max(-100, Math.min(100, value))));
  return {
    trades,
    winratePct,
    avgPnl,
    drawdownPct,
    sharpe,
    overfitGapPct: 0,
    score: 0,
  };
}


function parseIso(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const MANUAL_PROMOTION_ALLOWED_BLOCKERS = new Set([
  "live_handoff_disabled_by_policy",
  "shadow_drawdown_requires_more_observation",
  "shadow_overfit_gap_requires_more_observation",
]);

export function computeSelfLearningV5PromotionReadiness(state: SelfLearningV5State | null | undefined, strategyId?: string | null): SelfLearningV5PromotionReadiness {
  const shadowId = strategyId || state?.snapshot.registry.activeShadowStrategyId || null;
  const defaultObservation: SelfLearningV5PromotionReadiness = {
    candidateStrategyId: shadowId,
    requiredShadowCycles: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles,
    requiredObservationHours: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours,
    observedShadowCycles: 0,
    observedObservationHours: 0,
    eligibleForPromotion: false,
    firstObservedAt: null,
    lastObservedAt: null,
    reasons: shadowId ? ["shadow_strategy_not_found"] : ["no_active_shadow_strategy"],
  };
  if (!state || !shadowId) {
    return defaultObservation;
  }

  const entry = state.snapshot.registry.entries.find((item) => item.id === shadowId) || null;
  const cycles = state.cycles.filter((cycle) => cycle.bestStrategyId === shadowId);
  const cycleTimes = cycles
    .map((cycle) => ({ iso: cycle.timestampIso, at: parseIso(cycle.timestampIso) }))
    .filter((cycle): cycle is { iso: string; at: number } => cycle.at != null)
    .sort((left, right) => left.at - right.at);
  const firstObservedAt = cycleTimes[0]?.iso || null;
  const lastObservedAt = cycleTimes[cycleTimes.length - 1]?.iso || null;
  const observedObservationHours = firstObservedAt && lastObservedAt
    ? Math.max(0, (Date.parse(lastObservedAt) - Date.parse(firstObservedAt)) / 3600000)
    : 0;
  const reasons: string[] = [];

  if (!entry) {
    reasons.push("shadow_strategy_not_found");
  } else {
    if (!entry.validation.accepted) {
      reasons.push("strategy_not_accepted");
    }
    if (state.snapshot.registry.activeShadowStrategyId !== shadowId) {
      reasons.push("strategy_not_active_shadow");
    }
    if (entry.status !== "shadow" && entry.status !== "live-blocked") {
      reasons.push(`strategy_status_${entry.status}`);
    }
    const nonManualBlockers = entry.validation.liveBlockedReasons.filter((reason) => !MANUAL_PROMOTION_ALLOWED_BLOCKERS.has(reason));
    reasons.push(...nonManualBlockers);
  }

  if (cycles.length < SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles) {
    reasons.push(`shadow_cycle_count_below_${SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles}`);
  }
  if (observedObservationHours < SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours) {
    reasons.push(`shadow_observation_hours_below_${SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours}`);
  }

  return {
    candidateStrategyId: shadowId,
    requiredShadowCycles: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles,
    requiredObservationHours: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours,
    observedShadowCycles: cycles.length,
    observedObservationHours: Number(observedObservationHours.toFixed(2)),
    eligibleForPromotion: reasons.length === 0,
    firstObservedAt,
    lastObservedAt,
    reasons,
  };
}

export function promoteSelfLearningV5State(params: {
  state: SelfLearningV5State;
  strategyId: string;
  promotedBy: string;
  rationale: string;
}): { state: SelfLearningV5State; observation: SelfLearningV5PromotionReadiness; audit: SelfLearningV5PromotionAudit } {
  const observation = computeSelfLearningV5PromotionReadiness(params.state, params.strategyId);
  if (!observation.eligibleForPromotion) {
    throw new Error(`promotion_blocked:${observation.reasons.join(",")}`);
  }
  const sourceEntry = params.state.snapshot.registry.entries.find((entry) => entry.id === params.strategyId) || null;

  const promotedAt = new Date().toISOString();
  const updatedEntries = params.state.snapshot.registry.entries.map((entry) => {
    if (entry.id === params.strategyId) {
      return {
        ...entry,
        status: "live" as const,
        validation: {
          ...entry.validation,
          liveEligible: true,
          liveBlockedReasons: [],
        },
      };
    }
    if (entry.status === "live") {
      return {
        ...entry,
        status: "registry" as const,
      };
    }
    if (entry.status === "live-blocked") {
      return {
        ...entry,
        status: "shadow" as const,
      };
    }
    return entry;
  });

  const audit: SelfLearningV5PromotionAudit = {
    strategyId: params.strategyId,
    promotedAt,
    promotedBy: params.promotedBy,
    rationale: params.rationale,
    fromStatus: sourceEntry?.status || "shadow",
    toStatus: "live",
    observation: {
      requiredShadowCycles: observation.requiredShadowCycles,
      requiredObservationHours: observation.requiredObservationHours,
      observedShadowCycles: observation.observedShadowCycles,
      observedObservationHours: observation.observedObservationHours,
    },
  };

  return {
    observation: {
      ...observation,
      eligibleForPromotion: true,
      reasons: [],
    },
    audit,
    state: {
      ...params.state,
      modelUpdatedAt: promotedAt,
      snapshot: {
        ...params.state.snapshot,
        validation: {
          ...params.state.snapshot.validation,
          liveBlocked: false,
          liveBlockReasons: [],
        },
        registry: {
          ...params.state.snapshot.registry,
          activeShadowStrategyId: null,
          activeLiveStrategyId: params.strategyId,
          observation: {
            ...observation,
            eligibleForPromotion: true,
            reasons: [],
          },
          promotionAuditTrail: [audit, ...params.state.snapshot.registry.promotionAuditTrail].slice(0, 24),
          entries: updatedEntries,
        },
      },
      updatedAt: promotedAt,
    },
  };
}
function evaluateVariant(frames: SelfLearningV5Frame[], params: SelfLearningV5StrategyParams, allowLiveDeployment: boolean): VariantEvaluation {
  const splitIndex = Math.max(1, Math.floor(frames.length * 0.7));
  const train = frames.slice(0, splitIndex);
  const test = frames.slice(splitIndex);
  const trainMetrics = evaluateSlice(train, params);
  const testMetrics = evaluateSlice(test.length ? test : frames, params);
  const overfitGapPct = Math.abs(trainMetrics.winratePct - testMetrics.winratePct);
  const complexityPenalty = Math.max(0, params.imbalanceWeight + params.domWeight + params.liquidityWeight - 0.7) * 10;
  const score = (testMetrics.winratePct * 0.45) + (testMetrics.sharpe * 20) + (testMetrics.avgPnl * 0.15) - (testMetrics.drawdownPct * 1.4) - (overfitGapPct * 0.8) - complexityPenalty;
  const reasons: string[] = [];
  if (testMetrics.trades < DEFAULT_THRESHOLDS.minTrades) reasons.push("sample_too_small");
  if (testMetrics.winratePct < DEFAULT_THRESHOLDS.minWinratePct) reasons.push("winrate_below_floor");
  if (testMetrics.drawdownPct > DEFAULT_THRESHOLDS.maxDrawdownPct) reasons.push("drawdown_above_cap");
  if (testMetrics.sharpe < DEFAULT_THRESHOLDS.minSharpe) reasons.push("sharpe_below_floor");
  if (overfitGapPct > DEFAULT_THRESHOLDS.maxOverfitGapPct) reasons.push("overfit_gap_too_high");
  const accepted = reasons.length === 0;
  const liveBlockedReasons: string[] = [];
  if (!allowLiveDeployment) {
    liveBlockedReasons.push("live_handoff_disabled_by_policy");
  }
  if (testMetrics.drawdownPct > 5) {
    liveBlockedReasons.push("shadow_drawdown_requires_more_observation");
  }
  if (overfitGapPct > 6) {
    liveBlockedReasons.push("shadow_overfit_gap_requires_more_observation");
  }
  const status = !accepted
    ? "rejected"
    : liveBlockedReasons.length > 0
      ? "shadow"
      : "live";
  const entry: SelfLearningV5RegistryEntry = {
    id: `mh-${Math.abs(Math.round(score * 1000))}-${Math.round(params.absorptionThreshold * 100)}`,
    createdAt: new Date().toISOString(),
    status,
    params,
    metrics: {
      trades: testMetrics.trades,
      winratePct: Number(testMetrics.winratePct.toFixed(2)),
      avgPnl: Number(testMetrics.avgPnl.toFixed(4)),
      drawdownPct: Number(testMetrics.drawdownPct.toFixed(2)),
      sharpe: Number(testMetrics.sharpe.toFixed(3)),
      overfitGapPct: Number(overfitGapPct.toFixed(2)),
      score: Number(score.toFixed(3)),
    },
    validation: {
      accepted,
      reasons,
      liveEligible: accepted && liveBlockedReasons.length === 0,
      liveBlockedReasons,
    },
  };
  return { entry, score };
}

function buildDatasetCoverage(frames: SelfLearningV5Frame[]): number {
  if (!frames.length) {
    return 0;
  }
  let populated = 0;
  const maxFields = frames.length * 9;
  for (const frame of frames) {
    const values = Object.values(frame.features);
    populated += values.filter((value) => Number.isFinite(value) && value !== 0).length;
  }
  return maxFields > 0 ? (populated / maxFields) * 100 : 0;
}

export function runMetaHarnessSafeCycle(input: MetaHarnessSafeInput): SelfLearningV5State {
  const enabled = input.enabled !== false;
  const strictValidation = input.strictValidation !== false;
  const allowLiveDeployment = input.allowLiveDeployment === true;
  const frames = buildReplayDataset(input);
  const datasetSummary = summarizeReplayDataset(buildDatasetFromReplayFrames(frames));
  const cycleMiro = runMiroFishSimulation(buildMiroFishContextFromFrames(frames.slice(-48)));
  const base = buildBaseParams(input);
  const variants = generateVariants(base, frames);
  const evaluations = variants.map((variant) => evaluateVariant(frames, variant, allowLiveDeployment));
  const accepted = evaluations.filter((item) => item.entry.validation.accepted);
  const sorted = [...evaluations].sort((left, right) => right.score - left.score);
  const topEntries: SelfLearningV5RegistryEntry[] = sorted.slice(0, 12).map((item, index) => {
    const status: SelfLearningV5RegistryEntry["status"] = !item.entry.validation.accepted
      ? "rejected"
      : index === 0
        ? (item.entry.validation.liveEligible ? "live" : "shadow")
        : "registry";
    return {
      ...item.entry,
      status,
    };
  });
  const best = topEntries[0] || null;
  const liveBlockReasons = best?.validation.liveBlockedReasons || ["no_strategy_validated"];
  const cycleId = `mh-cycle-${Date.now()}`;
  const cycle: SelfLearningV5CycleSummary = {
    id: cycleId,
    timestampIso: new Date().toISOString(),
    summary: best
      ? `${accepted.length} variantes valides, meilleure=${best.id}, swarm=${cycleMiro.predictedDirection}/${(cycleMiro.confidence * 100).toFixed(0)}%, shadow=${best.status !== "live"}`
      : "aucune variante exploitable",
    bestStrategyId: best?.id || null,
    acceptedVariants: accepted.length,
    liveBlocked: !best || best.status !== "live",
  };
  const successRatePct = datasetSummary.successRatePct;
  const avgPnl = datasetSummary.avgPnl;
  const previousCycles = input.previousState?.cycles || [];
  const previousLiveStrategyId = input.previousState?.snapshot.registry.activeLiveStrategyId || null;
  const previousPromotionAuditTrail = input.previousState?.snapshot.registry.promotionAuditTrail || [];
  const promotedLiveEntry = previousLiveStrategyId
    ? topEntries.find((entry) => entry.id === previousLiveStrategyId) || null
    : null;
  const activeShadowStrategyId = best && best.validation.accepted && best.id !== previousLiveStrategyId
    ? best.id
    : null;
  const activeLiveStrategyId = promotedLiveEntry?.id || (best?.status === "live" ? best.id : null);
  const observation = computeSelfLearningV5PromotionReadiness({
    ...(input.previousState || {
      version: 1,
      accountId: input.accountId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      enabled,
      strictValidation,
      allowLiveDeployment,
      modelUpdatedAt: null,
      snapshot: {
        dataset: { sampleSize: 0, successRatePct: 0, avgPnl: 0, lastFrameAt: null, featureCoveragePct: 0 },
        optimizer: { runId: "", ranAt: new Date().toISOString(), generatedVariants: 0, evaluatedVariants: 0, acceptedVariants: 0, rejectedVariants: 0, bestStrategyId: null, bestScore: 0 },
        validation: { strict: strictValidation, thresholds: DEFAULT_THRESHOLDS, liveBlocked: true, liveBlockReasons: [] },
        registry: { activeShadowStrategyId: null, activeLiveStrategyId: null, observation: {
          candidateStrategyId: null,
          requiredShadowCycles: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles,
          requiredObservationHours: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours,
          observedShadowCycles: 0,
          observedObservationHours: 0,
          eligibleForPromotion: false,
          firstObservedAt: null,
          lastObservedAt: null,
          reasons: ["no_active_shadow_strategy"],
        }, promotionAuditTrail: [], entries: [] },
        datasetPreview: [],
      },
      cycles: [],
      updatedAt: new Date().toISOString(),
    }),
    snapshot: {
      ...(input.previousState?.snapshot || {
        dataset: { sampleSize: 0, successRatePct: 0, avgPnl: 0, lastFrameAt: null, featureCoveragePct: 0 },
        optimizer: { runId: "", ranAt: new Date().toISOString(), generatedVariants: 0, evaluatedVariants: 0, acceptedVariants: 0, rejectedVariants: 0, bestStrategyId: null, bestScore: 0 },
        validation: { strict: strictValidation, thresholds: DEFAULT_THRESHOLDS, liveBlocked: true, liveBlockReasons: [] },
        registry: { activeShadowStrategyId: null, activeLiveStrategyId: null, observation: {
          candidateStrategyId: null,
          requiredShadowCycles: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles,
          requiredObservationHours: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours,
          observedShadowCycles: 0,
          observedObservationHours: 0,
          eligibleForPromotion: false,
          firstObservedAt: null,
          lastObservedAt: null,
          reasons: ["no_active_shadow_strategy"],
        }, promotionAuditTrail: [], entries: [] },
        datasetPreview: [],
      }),
      registry: {
        activeShadowStrategyId,
        activeLiveStrategyId,
        observation: input.previousState?.snapshot.registry.observation || {
          candidateStrategyId: null,
          requiredShadowCycles: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredShadowCycles,
          requiredObservationHours: SELF_LEARNING_V5_PROMOTION_THRESHOLDS.requiredObservationHours,
          observedShadowCycles: 0,
          observedObservationHours: 0,
          eligibleForPromotion: false,
          firstObservedAt: null,
          lastObservedAt: null,
          reasons: ["no_active_shadow_strategy"],
        },
        promotionAuditTrail: previousPromotionAuditTrail,
        entries: topEntries,
      },
    },
    cycles: [cycle, ...previousCycles].slice(0, 24),
  }, activeShadowStrategyId);

  const finalizedEntries = topEntries.map((entry) => {
    if (entry.id === activeLiveStrategyId) {
      return {
        ...entry,
        status: "live" as const,
        validation: {
          ...entry.validation,
          liveEligible: true,
          liveBlockedReasons: [],
        },
      };
    }
    if (entry.id === activeShadowStrategyId && entry.validation.accepted) {
      return {
        ...entry,
        status: entry.validation.liveBlockedReasons.length > 0 ? "shadow" as const : "shadow" as const,
      };
    }
    return entry;
  });

  return {
    version: 1,
    accountId: input.accountId,
    symbol: input.symbol,
    timeframe: input.timeframe,
    enabled,
    strictValidation,
    allowLiveDeployment,
    modelUpdatedAt: new Date().toISOString(),
    snapshot: {
      dataset: {
        sampleSize: frames.length,
        successRatePct: Number(successRatePct.toFixed(2)),
        avgPnl: Number(avgPnl.toFixed(4)),
        lastFrameAt: frames[frames.length - 1]?.timestampIso || null,
        featureCoveragePct: Number(buildDatasetCoverage(frames).toFixed(2)),
      },
      optimizer: {
        runId: cycleId,
        ranAt: cycle.timestampIso,
        generatedVariants: variants.length,
        evaluatedVariants: evaluations.length,
        acceptedVariants: accepted.length,
        rejectedVariants: evaluations.length - accepted.length,
        bestStrategyId: best?.id || null,
        bestScore: Number((best?.metrics.score || 0).toFixed(3)),
      },
      validation: {
        strict: strictValidation,
        thresholds: DEFAULT_THRESHOLDS,
        liveBlocked: !activeLiveStrategyId,
        liveBlockReasons: activeLiveStrategyId ? [] : liveBlockReasons,
      },
      registry: {
        activeShadowStrategyId,
        activeLiveStrategyId,
        observation,
        promotionAuditTrail: previousPromotionAuditTrail,
        entries: finalizedEntries,
      },
      datasetPreview: frames.slice(-24),
    },
    cycles: [cycle, ...previousCycles].slice(0, 24),
    updatedAt: new Date().toISOString(),
  };
}