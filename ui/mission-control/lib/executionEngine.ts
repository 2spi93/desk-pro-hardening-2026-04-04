export type ExecutionEngineMode = "AGGRESSIVE" | "PASSIVE" | "MIROFLASH";

export type ExecutionEngineAction = "PLACE" | "WAIT" | "BLOCK";

export type ExecutionEngineActivation = "SHADOW" | "LIMITED_LIVE" | "FULL_LIVE";

type ExecutionTelemetryRecord = Record<string, unknown>;

type ExecutionEngineDomSnapshot = {
  bestBid: number | null;
  bestAsk: number | null;
  spread: number;
  depthBalance: number;
  liquidityScore: number;
  domDensity: number;
};

type ExecutionEngineWarfareSnapshot = {
  executionScore: number;
  guardAction: "ALLOW" | "BLOCK";
  venue: string;
  slices: number;
  delayMs: number;
  mode: "AGGRESSIVE" | "PASSIVE" | "STEALTH";
  trapState: "NORMAL" | "TRAP";
  adversarialState: "NORMAL" | "SPOOF" | "LIQUIDITY_FADE" | "STOP_HUNT" | "TRAP";
  maxSpreadMultiplier: number;
};

export type ExecutionEngineInput = {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  maxSpreadBps: number;
  domSnapshot: ExecutionEngineDomSnapshot | null;
  route: {
    venue: string;
    spreadBps: number;
    fillProbability: number;
    score: number;
  };
  warfare: ExecutionEngineWarfareSnapshot;
  recentTelemetry: ExecutionTelemetryRecord[];
  market: {
    tickLatencyMs: number;
    avgLatencyMs: number;
    avgSlippageBps: number;
    microBurstRate: number;
    predictedDeltaBps: number;
    fusionDeviationBps: number;
    priceStep: number;
  };
  requestLive: boolean;
};

export type ExecutionEngineSnapshot = {
  mode: ExecutionEngineMode;
  action: ExecutionEngineAction;
  activation: ExecutionEngineActivation;
  reasons: string[];
  entry: {
    style: "cross-spread" | "join-best" | "mid-flash";
    venue: string;
    price: number | null;
    referencePrice: number | null;
    targetSpreadBps: number;
    initialDelayMs: number;
    slices: number;
  };
  latency: {
    currentMs: number;
    guardMs: number;
    state: "nominal" | "elevated" | "critical";
  };
  slippage: {
    expectedBps: number;
    recentBps: number;
    budgetBps: number;
  };
  repricing: {
    enabled: boolean;
    action: "hold" | "reprice";
    trigger: "none" | "queue_decay" | "partial_fill" | "latency_drift" | "spread_expansion";
    maxAttempts: number;
    stepBps: number;
  };
  partialFillHandling: {
    action: "hold" | "reslice" | "cancel_replace";
    expectedFillRatio: number;
    recentFillRatio: number;
    targetFillRatio: number;
    resliceDelayMs: number;
  };
  shadow: {
    status: "promote" | "shadow" | "block";
    confidence: number;
  };
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : fallback;
}

function extractStatus(record: ExecutionTelemetryRecord): string {
  return String(record.status || record.execution_status || record.order_status || "").toLowerCase();
}

function extractFillRatio(record: ExecutionTelemetryRecord): number {
  const status = extractStatus(record);
  return clamp(
    toNumber(
      record.fill_ratio ?? record.executed_ratio,
      /partial/.test(status) ? 0.5 : /fill|done|complete|closed/.test(status) ? 1 : 0,
    ),
    0,
    1,
  );
}

function quantizePrice(price: number, priceStep: number): number {
  if (!(price > 0) || !(priceStep > 0)) {
    return price;
  }
  return Math.round(price / priceStep) * priceStep;
}

export function buildExecutionEngineSnapshot(input: ExecutionEngineInput): ExecutionEngineSnapshot {
  const bestBid = input.domSnapshot?.bestBid ?? null;
  const bestAsk = input.domSnapshot?.bestAsk ?? null;
  const referencePrice = bestBid !== null && bestAsk !== null
    ? (bestBid + bestAsk) * 0.5
    : bestBid ?? bestAsk ?? null;
  const domSpreadBps = referencePrice && input.domSnapshot
    ? (Math.max(0, input.domSnapshot.spread) / Math.max(referencePrice, 1e-9)) * 10000
    : Math.max(0, input.route.spreadBps);
  const spreadBps = Math.max(domSpreadBps, input.route.spreadBps);
  const depthBalance = clamp(input.domSnapshot?.depthBalance ?? 0, -1, 1);
  const alignedPressure = clamp(input.side === "buy" ? depthBalance : -depthBalance, -1, 1);
  const liquidityScore = clamp(input.domSnapshot?.liquidityScore ?? 0.45, 0.05, 1);
  const domDensity = clamp(input.domSnapshot?.domDensity ?? 0.35, 0, 1);
  const fillProbability = clamp(input.route.fillProbability, 0.05, 1);
  const currentLatencyMs = Math.max(0, input.market.tickLatencyMs, input.market.avgLatencyMs);
  const recentSlippageBps = Math.max(0, Math.abs(input.market.avgSlippageBps));
  const recentFillRatio = clamp(average(input.recentTelemetry.map(extractFillRatio), fillProbability), 0, 1);
  const recentRejectRate = clamp(
    average(
      input.recentTelemetry.map((item) => (/reject|error|fail|cancel|block/.test(extractStatus(item)) ? 1 : 0)),
      0,
    ),
    0,
    1,
  );
  const adverseScore = clamp(
    (input.warfare.adversarialState === "NORMAL" ? 0 : 0.2)
      + (input.warfare.trapState === "TRAP" ? 0.25 : 0)
      + input.market.microBurstRate * 0.22
      + clamp(Math.abs(input.market.fusionDeviationBps) / 20, 0, 0.2),
    0,
    1,
  );
  const latencyGuardMs = clamp(85 + (1 - liquidityScore) * 90 + spreadBps * 5 + adverseScore * 60, 90, 260);
  const latencyState = currentLatencyMs >= latencyGuardMs * 1.08
    ? "critical"
    : currentLatencyMs >= latencyGuardMs * 0.78
      ? "elevated"
      : "nominal";
  const miroflashEligible = spreadBps <= Math.max(1.1, input.maxSpreadBps * 0.55)
    && domDensity >= 0.48
    && liquidityScore >= 0.58
    && latencyState === "nominal"
    && adverseScore <= 0.28;
  const passiveEligible = spreadBps <= Math.max(1.4, input.maxSpreadBps * 0.9)
    && alignedPressure >= 0.08
    && fillProbability >= 0.56
    && adverseScore <= 0.45;
  const mode: ExecutionEngineMode = miroflashEligible
    ? "MIROFLASH"
    : passiveEligible
      ? "PASSIVE"
      : "AGGRESSIVE";
  const expectedFillRatio = clamp(
    fillProbability * 0.5
      + liquidityScore * 0.16
      + clamp((alignedPressure + 1) * 0.5, 0, 1) * 0.12
      + (mode === "AGGRESSIVE" ? 0.14 : mode === "MIROFLASH" ? 0.08 : 0.02)
      - spreadBps / 65
      - adverseScore * 0.18,
    0.08,
    0.995,
  );
  const expectedSlippageBps = clamp(
    spreadBps * (mode === "AGGRESSIVE" ? 0.95 : mode === "MIROFLASH" ? 0.62 : 0.42)
      + (1 - liquidityScore) * 5.8
      + currentLatencyMs / 42
      + adverseScore * 5.5
      - domDensity * 1.8,
    0,
    32,
  );

  const reasons: string[] = [];
  let action: ExecutionEngineAction = "PLACE";
  if (input.warfare.guardAction === "BLOCK") {
    action = "BLOCK";
    reasons.push("warfare_guard_blocked");
  }
  if (spreadBps > input.maxSpreadBps * 1.45) {
    action = "BLOCK";
    reasons.push("spread_outside_budget");
  } else if (spreadBps > input.maxSpreadBps && action !== "BLOCK") {
    action = "WAIT";
    reasons.push("spread_wait");
  }
  if (liquidityScore < 0.12) {
    action = "BLOCK";
    reasons.push("liquidity_too_thin");
  }
  if (latencyState === "critical") {
    action = "BLOCK";
    reasons.push("latency_critical");
  } else if (latencyState === "elevated" && action === "PLACE") {
    action = "WAIT";
    reasons.push("latency_elevated");
  }
  if (adverseScore > 0.72 && action !== "BLOCK") {
    action = "WAIT";
    reasons.push("adversarial_flow_wait");
  }

  const entryStyle = mode === "PASSIVE"
    ? "join-best"
    : mode === "MIROFLASH"
      ? "mid-flash"
      : "cross-spread";
  const referenceEntryPrice = input.side === "buy"
    ? entryStyle === "cross-spread"
      ? bestAsk ?? referencePrice ?? 0
      : entryStyle === "join-best"
        ? bestBid ?? referencePrice ?? 0
        : bestBid !== null && bestAsk !== null
          ? bestBid + (bestAsk - bestBid) * 0.35
          : referencePrice ?? 0
    : entryStyle === "cross-spread"
      ? bestBid ?? referencePrice ?? 0
      : entryStyle === "join-best"
        ? bestAsk ?? referencePrice ?? 0
        : bestBid !== null && bestAsk !== null
          ? bestAsk - (bestAsk - bestBid) * 0.35
          : referencePrice ?? 0;
  const entryPrice = referenceEntryPrice > 0
    ? quantizePrice(referenceEntryPrice, Math.max(input.market.priceStep, referenceEntryPrice * 0.00001))
    : null;
  const baseSlices = Math.max(1, input.warfare.slices);
  const slices = mode === "PASSIVE"
    ? Math.min(8, Math.max(baseSlices, Math.ceil(input.notionalUsd / 150)))
    : mode === "MIROFLASH"
      ? Math.max(1, Math.min(baseSlices, 3))
      : baseSlices;
  const initialDelayMs = action === "WAIT"
    ? Math.max(input.warfare.delayMs, mode === "PASSIVE" ? 120 : 75)
    : Math.max(mode === "PASSIVE" ? 30 : mode === "MIROFLASH" ? 12 : 0, input.warfare.delayMs);
  const repricingAction = action === "BLOCK"
    ? "hold"
    : expectedFillRatio < 0.72 || latencyState !== "nominal" || spreadBps > input.maxSpreadBps * 0.92
      ? "reprice"
      : "hold";
  const repricingTrigger = spreadBps > input.maxSpreadBps * 0.92
    ? "spread_expansion"
    : expectedFillRatio < 0.6
      ? "partial_fill"
      : latencyState !== "nominal"
        ? "latency_drift"
        : repricingAction === "reprice"
          ? "queue_decay"
          : "none";
  const repricingAttempts = repricingAction === "reprice"
    ? mode === "MIROFLASH"
      ? 2
      : 1
    : 0;
  const partialFillAction = action === "BLOCK"
    ? "hold"
    : expectedFillRatio < 0.56 || recentFillRatio < 0.52
      ? "cancel_replace"
      : expectedFillRatio < 0.78 || input.notionalUsd >= 500
        ? "reslice"
        : "hold";
  const targetFillRatio = clamp(mode === "AGGRESSIVE" ? 0.78 : mode === "MIROFLASH" ? 0.7 : 0.64, 0.55, 0.9);
  const budgetBps = clamp(
    Math.min(input.maxSpreadBps * input.warfare.maxSpreadMultiplier, Math.max(1, expectedSlippageBps + 1.25)),
    1,
    Math.max(1, input.maxSpreadBps * input.warfare.maxSpreadMultiplier),
  );
  const confidence = clamp(
    input.warfare.executionScore * 0.4
      + expectedFillRatio * 0.25
      + liquidityScore * 0.15
      + clamp(1 - expectedSlippageBps / Math.max(input.maxSpreadBps * 2, 6), 0, 1) * 0.1
      + clamp(1 - recentRejectRate, 0, 1) * 0.1,
    0,
    1,
  );
  const activation: ExecutionEngineActivation = !input.requestLive || action === "BLOCK"
    ? "SHADOW"
    : confidence >= 0.74 && recentRejectRate <= 0.14 && latencyState === "nominal"
      ? "FULL_LIVE"
      : "LIMITED_LIVE";
  const shadowStatus = action === "BLOCK"
    ? "block"
    : activation === "FULL_LIVE"
      ? "promote"
      : "shadow";

  return {
    mode,
    action,
    activation,
    reasons,
    entry: {
      style: entryStyle,
      venue: input.route.venue || input.warfare.venue,
      price: entryPrice,
      referencePrice,
      targetSpreadBps: spreadBps,
      initialDelayMs,
      slices,
    },
    latency: {
      currentMs: currentLatencyMs,
      guardMs: latencyGuardMs,
      state: latencyState,
    },
    slippage: {
      expectedBps: expectedSlippageBps,
      recentBps: recentSlippageBps,
      budgetBps,
    },
    repricing: {
      enabled: repricingAction === "reprice",
      action: repricingAction,
      trigger: repricingTrigger,
      maxAttempts: repricingAttempts,
      stepBps: clamp(Math.max(spreadBps * 0.55, input.market.priceStep > 0 && referencePrice ? (input.market.priceStep / referencePrice) * 10000 : 0.4), 0.25, 6),
    },
    partialFillHandling: {
      action: partialFillAction,
      expectedFillRatio,
      recentFillRatio,
      targetFillRatio,
      resliceDelayMs: mode === "PASSIVE" ? 120 : 45,
    },
    shadow: {
      status: shadowStatus,
      confidence,
    },
  };
}