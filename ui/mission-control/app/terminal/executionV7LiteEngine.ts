type JsonMap = Record<string, unknown>;

export type ExecutionIntent = {
  symbol: string;
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  effectiveNotionalUsd: number;
  requestedLots?: number;
  preferredVenue: string;
  rationale: string;
  maxSpreadBps: number;
  slippageBudgetBps: number;
  expectedSlippageBps: number;
  latencyGuardMs: number;
  requestedSlices: number;
  maxSlices: number;
  minSliceNotionalUsd: number;
  initialDelayMs: number;
  baseSliceDelayMs: number;
  repriceStepBps: number;
  maxRetries: number;
  partialFillAction: "none" | "reslice" | "cancel_replace";
  partialFillTargetRatio: number;
  expectedFillRatio: number;
  resliceDelayMs: number;
  riskSizingMultiplier: number;
  autoOptimizationMultiplier: number;
  metadata?: JsonMap;
  orderIntent?: JsonMap;
};

export type ExecutionContext = {
  spreadBps: number;
  volatilityBps: number;
  liquidityScore: number;
  microTrend: "up" | "down" | "flat";
  flowImbalance: number;
  spoofingScore: number;
  expectedLatencyMs: number;
  queuePressure: number;
  marketPressure: "buy" | "sell" | "neutral";
};

export type ExecutionVenueLearningProfile = {
  venue: string;
  samples: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  fillRatio: number;
  rejectRate: number;
  score: number;
};

export type ExecutionSmartGateDecision = {
  allow: boolean;
  reasons: string[];
  recommendedDelayMs: number;
  sizeMultiplier: number;
  contextScore: number;
  venueScore: number;
  executionScore: number;
};

export type ExecutionPlanSliceDraft = {
  id: string;
  venue: string;
  notionalUsd: number;
  plannedDelayMs: number;
  state?: string;
  replaceCount: number;
  resliceEligible: boolean;
};

export type ExecutionPlanSlice = ExecutionPlanSliceDraft & {
  index: number;
  maxSpreadBps: number;
  retryBudget: number;
};

export type ExecutionPlan = {
  intent: ExecutionIntent;
  initialDelayMs: number;
  slices: ExecutionPlanSlice[];
  totalNotionalUsd: number;
};

export type ExecutionFollowUpAttempt = {
  type: "cancel_replace" | "reslice";
  status: string;
  fillRatio: number;
  latencyMs: number;
  realizedSlippageBps: number;
};

export type ExecutionAttemptSegment = {
  type: "initial" | "cancel_replace" | "reslice";
  status: string;
  fillRatio: number;
  executedNotionalUsd: number;
  latencyMs: number;
  realizedSlippageBps: number;
};

export type ExecutionAttemptOutcome = {
  sliceId: string;
  sliceIndex: number;
  venue: string;
  plannedNotionalUsd: number;
  executedNotionalUsd: number;
  remainingNotionalUsd: number;
  fillRatio: number;
  latencyMs: number;
  realizedSlippageBps: number;
  status: "filled" | "partial" | "failed" | "open";
  followUpCount: number;
  segments: ExecutionAttemptSegment[];
};

export type ExecutionFeedbackMetrics = {
  success: boolean;
  fillProbability: number;
  fillRatio: number;
  slippageBps: number;
  latencyMs: number;
  executionScore: number;
  failureSource: string;
  venue: string;
};

export type ExecutionResult = {
  ok: boolean;
  status: "filled" | "partial" | "failed" | "blocked";
  requestedNotionalUsd: number;
  effectiveNotionalUsd: number;
  executedNotionalUsd: number;
  remainingNotionalUsd: number;
  fillRatio: number;
  averageFillRatio: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  sliceCount: number;
  attemptedSliceCount: number;
  followUpCount: number;
  venue: string;
  stopReason: string;
  slippageGuardTriggered: boolean;
  latencyGuardTriggered: boolean;
  context: ExecutionContext | null;
  venueLearning: ExecutionVenueLearningProfile | null;
  smartGate: ExecutionSmartGateDecision | null;
  feedback: ExecutionFeedbackMetrics;
};

export type ExecutionContinuationDecision = {
  shouldContinue: boolean;
  reason: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 3): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return 0;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function weightedAverage(values: Array<{ value: number; weight: number }>, fallback = 0): number {
  const filtered = values.filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.weight) && entry.weight > 0);
  if (filtered.length === 0) {
    return fallback;
  }
  const weightSum = filtered.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(weightSum > 0)) {
    return fallback;
  }
  return filtered.reduce((sum, entry) => sum + entry.value * entry.weight, 0) / weightSum;
}

function normalizePartialFillAction(value: string): "none" | "reslice" | "cancel_replace" {
  return value === "reslice" || value === "cancel_replace" ? value : "none";
}

function normalizeMicroTrend(value: string): "up" | "down" | "flat" {
  return value === "up" || value === "down" ? value : "flat";
}

function normalizeStatus(status: string, executedRatio: number): "filled" | "partial" | "failed" | "open" {
  const lowered = status.toLowerCase();
  if (executedRatio >= 0.999 || /fill|done|complete|closed/.test(lowered)) {
    return "filled";
  }
  if (executedRatio > 0 || /partial/.test(lowered)) {
    return "partial";
  }
  if (/reject|error|fail|cancel|block/.test(lowered)) {
    return "failed";
  }
  return "open";
}

function resolveFailureSource(input: {
  status: ExecutionResult["status"];
  slippageGuardTriggered: boolean;
  latencyGuardTriggered: boolean;
  fillRatio: number;
  targetFillRatio: number;
}): string {
  if (input.slippageGuardTriggered) {
    return "slippage_guard";
  }
  if (input.latencyGuardTriggered) {
    return "latency_guard";
  }
  if (input.status === "failed") {
    return "execution_failed";
  }
  if (input.fillRatio > 0 && input.fillRatio < input.targetFillRatio) {
    return "partial_fill";
  }
  return "";
}

export function createExecutionV7LiteIntent(input: {
  symbol: string;
  side: "buy" | "sell";
  requestedNotionalUsd: number;
  effectiveNotionalUsd: number;
  requestedLots?: number;
  preferredVenue?: string;
  rationale?: string;
  maxSpreadBps: number;
  slippageBudgetBps: number;
  expectedSlippageBps: number;
  latencyGuardMs: number;
  requestedSlices: number;
  maxSlices?: number;
  minSliceNotionalUsd?: number;
  initialDelayMs?: number;
  baseSliceDelayMs?: number;
  repriceStepBps?: number;
  maxRetries?: number;
  partialFillAction?: string;
  partialFillTargetRatio?: number;
  expectedFillRatio?: number;
  resliceDelayMs?: number;
  riskSizingMultiplier?: number;
  autoOptimizationMultiplier?: number;
  metadata?: JsonMap;
  orderIntent?: JsonMap;
}): ExecutionIntent {
  return {
    symbol: String(input.symbol || "").trim(),
    side: input.side === "sell" ? "sell" : "buy",
    requestedNotionalUsd: Math.max(0, round(input.requestedNotionalUsd, 2)),
    effectiveNotionalUsd: Math.max(0, round(input.effectiveNotionalUsd, 2)),
    requestedLots: typeof input.requestedLots === "number" && Number.isFinite(input.requestedLots) ? input.requestedLots : undefined,
    preferredVenue: String(input.preferredVenue || "").trim(),
    rationale: String(input.rationale || "").trim(),
    maxSpreadBps: clamp(input.maxSpreadBps, 0.25, 100),
    slippageBudgetBps: clamp(input.slippageBudgetBps, 0.25, 100),
    expectedSlippageBps: clamp(input.expectedSlippageBps, 0, 100),
    latencyGuardMs: Math.max(0, round(input.latencyGuardMs, 0)),
    requestedSlices: Math.max(1, Math.floor(input.requestedSlices || 1)),
    maxSlices: Math.max(1, Math.floor(input.maxSlices || 8)),
    minSliceNotionalUsd: Math.max(1, round(input.minSliceNotionalUsd || 25, 2)),
    initialDelayMs: Math.max(0, Math.round(input.initialDelayMs || 0)),
    baseSliceDelayMs: Math.max(0, Math.round(input.baseSliceDelayMs || 0)),
    repriceStepBps: Math.max(0, round(input.repriceStepBps || 0, 2)),
    maxRetries: Math.max(0, Math.floor(input.maxRetries || 0)),
    partialFillAction: normalizePartialFillAction(String(input.partialFillAction || "")),
    partialFillTargetRatio: clamp(input.partialFillTargetRatio ?? 0.7, 0.05, 1),
    expectedFillRatio: clamp(input.expectedFillRatio ?? 0.7, 0.05, 1),
    resliceDelayMs: Math.max(0, Math.round(input.resliceDelayMs || 0)),
    riskSizingMultiplier: Math.max(0, round(input.riskSizingMultiplier ?? 1, 4)),
    autoOptimizationMultiplier: Math.max(0, round(input.autoOptimizationMultiplier ?? 1, 4)),
    metadata: input.metadata,
    orderIntent: input.orderIntent,
  };
}

export function buildExecutionV7LiteContext(input: {
  spreadBps: number;
  volatilityBps: number;
  liquidityScore: number;
  microTrend: string;
  flowImbalance: number;
  spoofingScore: number;
  expectedLatencyMs: number;
  queuePressure: number;
  marketPressure: string;
}): ExecutionContext {
  return {
    spreadBps: Math.max(0, round(input.spreadBps, 3)),
    volatilityBps: Math.max(0, round(input.volatilityBps, 3)),
    liquidityScore: clamp(input.liquidityScore, 0, 1),
    microTrend: normalizeMicroTrend(String(input.microTrend || "flat")),
    flowImbalance: clamp(input.flowImbalance, -1, 1),
    spoofingScore: clamp(Math.abs(input.spoofingScore), 0, 1),
    expectedLatencyMs: Math.max(0, round(input.expectedLatencyMs, 3)),
    queuePressure: clamp(input.queuePressure, 0, 1),
    marketPressure: input.marketPressure === "buy" || input.marketPressure === "sell" ? input.marketPressure : "neutral",
  };
}

export function buildExecutionV7LiteVenueLearningProfile(input: {
  venue: string;
  samples: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  fillRatio: number;
  rejectRate: number;
}): ExecutionVenueLearningProfile {
  const latencyScore = clamp(1 - input.avgLatencyMs / 240, 0.05, 1);
  const slippageScore = clamp(1 - input.avgSlippageBps / 14, 0.05, 1);
  const fillScore = clamp(input.fillRatio, 0.05, 1);
  const rejectScore = clamp(1 - input.rejectRate, 0.05, 1);
  const sampleConfidence = clamp(input.samples / 12, 0.2, 1);
  return {
    venue: String(input.venue || "").trim().toLowerCase(),
    samples: Math.max(0, Math.floor(input.samples || 0)),
    avgLatencyMs: Math.max(0, round(input.avgLatencyMs, 3)),
    avgSlippageBps: Math.max(0, round(input.avgSlippageBps, 3)),
    fillRatio: clamp(input.fillRatio, 0, 1),
    rejectRate: clamp(input.rejectRate, 0, 1),
    score: round(clamp(
      latencyScore * 0.26
        + slippageScore * 0.3
        + fillScore * 0.28
        + rejectScore * 0.16,
      0,
      1,
    ) * sampleConfidence + (1 - sampleConfidence) * 0.55, 6),
  };
}

export function evaluateExecutionV7LiteSmartGate(input: {
  intent: ExecutionIntent;
  context: ExecutionContext;
  venueLearning?: ExecutionVenueLearningProfile | null;
}): ExecutionSmartGateDecision {
  const context = input.context;
  const spreadPressure = context.spreadBps / Math.max(0.25, input.intent.maxSpreadBps);
  const volatilityPressure = context.volatilityBps / Math.max(8, input.intent.expectedSlippageBps * 6 + 8);
  const latencyPressure = input.intent.latencyGuardMs > 0
    ? context.expectedLatencyMs / Math.max(1, input.intent.latencyGuardMs)
    : 0.4;
  const alignedMicroTrend = context.microTrend === "flat"
    ? 0.58
    : (input.intent.side === "buy" && context.microTrend === "up") || (input.intent.side === "sell" && context.microTrend === "down")
      ? 1
      : 0.18;
  const alignedPressure = context.marketPressure === "neutral"
    ? 0.56
    : (input.intent.side === "buy" && context.marketPressure === "buy") || (input.intent.side === "sell" && context.marketPressure === "sell")
      ? 1
      : 0.18;
  const venueScore = input.venueLearning?.score ?? 0.55;
  const contextScore = clamp(
    context.liquidityScore * 0.24
      + clamp(1 - spreadPressure / 1.5, 0, 1) * 0.18
      + clamp(1 - volatilityPressure / 1.45, 0, 1) * 0.12
      + clamp(1 - latencyPressure / 1.45, 0, 1) * 0.12
      + alignedMicroTrend * 0.14
      + alignedPressure * 0.08
      + clamp(1 - context.queuePressure, 0, 1) * 0.07
      + clamp(1 - context.spoofingScore, 0, 1) * 0.05,
    0,
    1,
  );
  const executionScore = clamp(contextScore * 0.72 + venueScore * 0.28, 0, 1);
  const reasons: string[] = [];
  if (spreadPressure > 1.08) {
    reasons.push("spread_expanding");
  }
  if (context.liquidityScore < 0.14) {
    reasons.push("liquidity_thin");
  }
  if (context.spoofingScore > 0.88) {
    reasons.push("spoofing_risk");
  }
  if (latencyPressure > 1.15) {
    reasons.push("latency_over_guard");
  }
  if (volatilityPressure > 1.12 && context.liquidityScore < 0.3) {
    reasons.push("volatility_spike_thin_liquidity");
  }
  if (context.queuePressure > 0.86 && context.liquidityScore < 0.42) {
    reasons.push("queue_pressure_extreme");
  }
  if (alignedMicroTrend < 0.25 && context.queuePressure > 0.62) {
    reasons.push("micro_trend_misaligned");
  }
  if ((input.venueLearning?.samples || 0) >= 4 && venueScore < 0.38) {
    reasons.push("venue_quality_degraded");
  }

  const allow = reasons.length === 0;
  let sizeMultiplier = 1;
  if (allow) {
    sizeMultiplier = executionScore >= 0.78
      ? 1
      : executionScore >= 0.64
        ? 0.82
        : executionScore >= 0.52
          ? 0.64
          : 0.48;
    if (venueScore < 0.45) {
      sizeMultiplier *= 0.82;
    }
    if (context.queuePressure > 0.7) {
      sizeMultiplier *= 0.86;
    }
    if (context.spoofingScore > 0.6) {
      sizeMultiplier *= 0.84;
    }
    sizeMultiplier = clamp(sizeMultiplier, 0.25, 1);
  } else {
    sizeMultiplier = 0;
  }

  const recommendedDelayMs = allow
    ? Math.round(clamp(
      Math.max(0, spreadPressure - 0.72) * 55
        + Math.max(0, volatilityPressure - 0.75) * 35
        + context.queuePressure * 42
        + context.spoofingScore * 28
        + (venueScore < 0.5 ? 18 : 0),
      0,
      180,
    ))
    : Math.round(clamp(input.intent.baseSliceDelayMs + 60, 60, 240));

  return {
    allow,
    reasons,
    recommendedDelayMs,
    sizeMultiplier: round(sizeMultiplier, 6),
    contextScore: round(contextScore, 6),
    venueScore: round(venueScore, 6),
    executionScore: round(executionScore, 6),
  };
}

export function buildExecutionV7LitePlan(input: {
  intent: ExecutionIntent;
  slices: ExecutionPlanSliceDraft[];
}): ExecutionPlan {
  const requestedSlices = input.slices
    .filter((slice) => Number.isFinite(slice.notionalUsd) && slice.notionalUsd > 0)
    .slice(0, input.intent.maxSlices)
    .map((slice, index) => ({
      id: slice.id || `${input.intent.symbol || "execution"}-${index + 1}`,
      venue: String(slice.venue || input.intent.preferredVenue || "").trim(),
      notionalUsd: round(slice.notionalUsd, 2),
      plannedDelayMs: Math.max(0, Math.round(slice.plannedDelayMs || (index > 0 ? input.intent.baseSliceDelayMs : 0))),
      state: String(slice.state || "planned"),
      replaceCount: Math.max(0, Math.floor(slice.replaceCount || 0)),
      resliceEligible: Boolean(slice.resliceEligible),
    }));
  const fallbackSlices = requestedSlices.length > 0
    ? requestedSlices
    : [{
      id: `${input.intent.symbol || "execution"}-1`,
      venue: input.intent.preferredVenue,
      notionalUsd: round(input.intent.effectiveNotionalUsd, 2),
      plannedDelayMs: 0,
      state: "planned",
      replaceCount: input.intent.maxRetries,
      resliceEligible: input.intent.partialFillAction === "reslice",
    }];
  const merged: ExecutionPlanSliceDraft[] = [];
  for (const slice of fallbackSlices) {
    const last = merged[merged.length - 1];
    if (last && slice.notionalUsd < input.intent.minSliceNotionalUsd) {
      last.notionalUsd = round(last.notionalUsd + slice.notionalUsd, 2);
      last.replaceCount = Math.max(last.replaceCount, slice.replaceCount);
      last.resliceEligible = last.resliceEligible || slice.resliceEligible;
      continue;
    }
    merged.push({ ...slice });
  }
  if (merged.length === 0) {
    merged.push({
      id: `${input.intent.symbol || "execution"}-1`,
      venue: input.intent.preferredVenue,
      notionalUsd: round(input.intent.effectiveNotionalUsd, 2),
      plannedDelayMs: 0,
      state: "planned",
      replaceCount: input.intent.maxRetries,
      resliceEligible: input.intent.partialFillAction === "reslice",
    });
  }
  const mergedNotionalUsd = merged.reduce((sum, slice) => sum + slice.notionalUsd, 0);
  const deltaNotionalUsd = round(input.intent.effectiveNotionalUsd - mergedNotionalUsd, 2);
  if (merged.length > 0 && Math.abs(deltaNotionalUsd) > 0.009) {
    merged[merged.length - 1].notionalUsd = round(Math.max(0, merged[merged.length - 1].notionalUsd + deltaNotionalUsd), 2);
  }
  const slices = merged
    .filter((slice) => slice.notionalUsd > 0)
    .map((slice, index) => ({
      ...slice,
      index: index + 1,
      maxSpreadBps: round(input.intent.maxSpreadBps, 2),
      retryBudget: Math.max(input.intent.maxRetries, slice.replaceCount),
    }));

  return {
    intent: input.intent,
    initialDelayMs: input.intent.initialDelayMs,
    slices,
    totalNotionalUsd: round(slices.reduce((sum, slice) => sum + slice.notionalUsd, 0), 2),
  };
}

export function buildExecutionV7LiteAttempt(input: {
  slice: ExecutionPlanSlice;
  venue?: string;
  status: string;
  fillRatio: number;
  latencyMs: number;
  realizedSlippageBps: number;
  followUps?: ExecutionFollowUpAttempt[];
}): ExecutionAttemptOutcome {
  const followUps = Array.isArray(input.followUps) ? input.followUps : [];
  let remainingNotionalUsd = input.slice.notionalUsd;
  const segments: ExecutionAttemptSegment[] = [];
  const materializeSegment = (
    type: ExecutionAttemptSegment["type"],
    status: string,
    rawFillRatio: number,
    latencyMs: number,
    realizedSlippageBps: number,
  ): void => {
    const fillRatio = clamp(rawFillRatio, 0, 1);
    const executedNotionalUsd = round(remainingNotionalUsd * fillRatio, 6);
    remainingNotionalUsd = round(Math.max(0, remainingNotionalUsd - executedNotionalUsd), 6);
    segments.push({
      type,
      status,
      fillRatio,
      executedNotionalUsd,
      latencyMs: Math.max(0, round(latencyMs, 3)),
      realizedSlippageBps: Math.max(0, round(realizedSlippageBps, 3)),
    });
  };

  materializeSegment("initial", input.status, input.fillRatio, input.latencyMs, input.realizedSlippageBps);
  for (const followUp of followUps) {
    materializeSegment(
      followUp.type,
      followUp.status,
      followUp.fillRatio,
      followUp.latencyMs,
      followUp.realizedSlippageBps,
    );
  }

  const executedNotionalUsd = round(segments.reduce((sum, segment) => sum + segment.executedNotionalUsd, 0), 6);
  const fillRatio = input.slice.notionalUsd > 0 ? clamp(executedNotionalUsd / input.slice.notionalUsd, 0, 1) : 0;
  const latencyMs = weightedAverage(
    segments.map((segment) => ({ value: segment.latencyMs, weight: segment.executedNotionalUsd || input.slice.notionalUsd || 1 })),
    average(segments.map((segment) => segment.latencyMs)),
  );
  const realizedSlippageBps = weightedAverage(
    segments.map((segment) => ({ value: segment.realizedSlippageBps, weight: segment.executedNotionalUsd || input.slice.notionalUsd || 1 })),
    average(segments.map((segment) => segment.realizedSlippageBps)),
  );
  const lastStatus = segments[segments.length - 1]?.status || input.status;

  return {
    sliceId: input.slice.id,
    sliceIndex: input.slice.index,
    venue: String(input.venue || input.slice.venue || "").trim(),
    plannedNotionalUsd: round(input.slice.notionalUsd, 2),
    executedNotionalUsd: round(executedNotionalUsd, 6),
    remainingNotionalUsd: round(remainingNotionalUsd, 6),
    fillRatio: round(fillRatio, 6),
    latencyMs: round(latencyMs, 3),
    realizedSlippageBps: round(realizedSlippageBps, 3),
    status: normalizeStatus(lastStatus, fillRatio),
    followUpCount: followUps.length,
    segments,
  };
}

function summarizeExecutionProgress(plan: ExecutionPlan, attempts: ExecutionAttemptOutcome[]): {
  executedNotionalUsd: number;
  fillRatio: number;
  avgSlippageBps: number;
  avgLatencyMs: number;
} {
  const executedNotionalUsd = attempts.reduce((sum, attempt) => sum + attempt.executedNotionalUsd, 0);
  return {
    executedNotionalUsd,
    fillRatio: plan.totalNotionalUsd > 0 ? clamp(executedNotionalUsd / plan.totalNotionalUsd, 0, 1) : 0,
    avgSlippageBps: weightedAverage(
      attempts.map((attempt) => ({ value: attempt.realizedSlippageBps, weight: attempt.executedNotionalUsd || attempt.plannedNotionalUsd || 1 })),
      average(attempts.map((attempt) => attempt.realizedSlippageBps)),
    ),
    avgLatencyMs: weightedAverage(
      attempts.map((attempt) => ({ value: attempt.latencyMs, weight: attempt.executedNotionalUsd || attempt.plannedNotionalUsd || 1 })),
      average(attempts.map((attempt) => attempt.latencyMs)),
    ),
  };
}

export function evaluateExecutionV7LiteContinuation(input: {
  plan: ExecutionPlan;
  attempts: ExecutionAttemptOutcome[];
}): ExecutionContinuationDecision {
  if (input.attempts.length === 0 || input.attempts.length >= input.plan.slices.length) {
    return { shouldContinue: false, reason: "complete" };
  }
  const latestAttempt = input.attempts[input.attempts.length - 1];
  const progress = summarizeExecutionProgress(input.plan, input.attempts);
  if (
    latestAttempt.realizedSlippageBps > input.plan.intent.slippageBudgetBps * 1.15
    && latestAttempt.fillRatio < input.plan.intent.partialFillTargetRatio
  ) {
    return { shouldContinue: false, reason: "slippage_guard" };
  }
  if (
    progress.avgSlippageBps > input.plan.intent.slippageBudgetBps
    && progress.fillRatio < Math.max(0.3, input.plan.intent.expectedFillRatio * 0.65)
    && input.attempts.length >= 2
  ) {
    return { shouldContinue: false, reason: "slippage_persisting" };
  }
  if (latestAttempt.status === "failed" && progress.fillRatio < 0.2 && input.attempts.length >= Math.min(2, input.plan.slices.length)) {
    return { shouldContinue: false, reason: "execution_fail_streak" };
  }
  return { shouldContinue: true, reason: "continue" };
}

export function finalizeExecutionV7LiteResult(input: {
  plan: ExecutionPlan;
  attempts: ExecutionAttemptOutcome[];
  stopReason?: string | null;
  context?: ExecutionContext | null;
  venueLearning?: ExecutionVenueLearningProfile | null;
  smartGate?: ExecutionSmartGateDecision | null;
}): ExecutionResult {
  const progress = summarizeExecutionProgress(input.plan, input.attempts);
  const averageFillRatio = average(input.attempts.map((attempt) => attempt.fillRatio));
  const remainingNotionalUsd = round(Math.max(0, input.plan.totalNotionalUsd - progress.executedNotionalUsd), 6);
  const terminalAttempt = input.attempts[input.attempts.length - 1] || null;
  const slippageGuardTriggered = input.stopReason === "slippage_guard" || input.stopReason === "slippage_persisting";
  const latencyGuardTriggered = progress.avgLatencyMs > input.plan.intent.latencyGuardMs && input.plan.intent.latencyGuardMs > 0;
  let status: ExecutionResult["status"] = "blocked";
  if (input.attempts.length > 0) {
    status = progress.fillRatio >= 0.999
      ? "filled"
      : progress.fillRatio > 0
        ? "partial"
        : terminalAttempt?.status === "failed"
          ? "failed"
          : "failed";
  } else if (input.plan.totalNotionalUsd > 0) {
    status = "failed";
  }
  const ok = status === "filled"
    || (status === "partial"
      && progress.fillRatio >= input.plan.intent.partialFillTargetRatio
      && progress.avgSlippageBps <= input.plan.intent.slippageBudgetBps * 1.15);
  const venue = terminalAttempt?.venue || input.plan.intent.preferredVenue || "";
  const feedbackFailureSource = resolveFailureSource({
    status,
    slippageGuardTriggered,
    latencyGuardTriggered,
    fillRatio: progress.fillRatio,
    targetFillRatio: input.plan.intent.partialFillTargetRatio,
  });

  return {
    ok,
    status,
    requestedNotionalUsd: round(input.plan.intent.requestedNotionalUsd, 2),
    effectiveNotionalUsd: round(input.plan.totalNotionalUsd, 2),
    executedNotionalUsd: round(progress.executedNotionalUsd, 6),
    remainingNotionalUsd,
    fillRatio: round(progress.fillRatio, 6),
    averageFillRatio: round(averageFillRatio, 6),
    avgLatencyMs: round(progress.avgLatencyMs, 3),
    avgSlippageBps: round(progress.avgSlippageBps, 3),
    sliceCount: input.plan.slices.length,
    attemptedSliceCount: input.attempts.length,
    followUpCount: input.attempts.reduce((sum, attempt) => sum + attempt.followUpCount, 0),
    venue,
    stopReason: String(input.stopReason || ""),
    slippageGuardTriggered,
    latencyGuardTriggered,
    context: input.context || null,
    venueLearning: input.venueLearning || null,
    smartGate: input.smartGate || null,
    feedback: {
      success: ok,
      fillProbability: round(clamp(progress.fillRatio > 0 ? progress.fillRatio : input.plan.intent.expectedFillRatio, 0, 1), 6),
      fillRatio: round(progress.fillRatio, 6),
      slippageBps: round(progress.avgSlippageBps, 3),
      latencyMs: round(progress.avgLatencyMs, 3),
      executionScore: round(input.smartGate?.executionScore ?? clamp((progress.fillRatio * 0.65) + clamp(1 - progress.avgSlippageBps / Math.max(input.plan.intent.slippageBudgetBps * 2, 4), 0, 1) * 0.35, 0, 1), 6),
      failureSource: feedbackFailureSource,
      venue,
    },
  };
}