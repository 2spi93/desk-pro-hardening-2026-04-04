export type WarfareVenueCandidate = {
  venue: string;
  latencyMs: number;
  depthUsd: number;
  spreadBps: number;
  fillProbability: number;
  score: number;
};

export type LiquidityState = {
  imbalance: number;
  absorption: number;
  hiddenLiquidity: number;
  spoofProbability: number;
  sweepRisk: number;
  liquidityScore: number;
  trapState: "NORMAL" | "TRAP";
};

export type AdversarialMarketState = "NORMAL" | "SPOOF" | "LIQUIDITY_FADE" | "STOP_HUNT" | "TRAP";

export type ExecutionWarfareState = {
  volatility: number;
  spreadBps: number;
  liquidity: number;
  imbalance: number;
  absorption: number;
  hiddenLiquidity: number;
  spoofProbability: number;
  sweepRisk: number;
  ownLatencyMs: number;
  marketLatencyMs: number;
  fillProbability: number;
  slippageBps: number;
  depthScore: number;
  notionalUsd: number;
  executionEdgeBps: number;
  venues: WarfareVenueCandidate[];
  tapeBuyPressure: number;
  tapeSellPressure: number;
  microBurstRate: number;
};

export type ExecutionWarfareMode = "AGGRESSIVE" | "PASSIVE" | "STEALTH";

export type ExecutionWarfarePlan = {
  venue: string;
  mode: ExecutionWarfareMode;
  slices: number;
  delayMs: number;
  sliceNotionalUsd: number;
  latencyEdgeMs: number;
  maxSpreadMultiplier: number;
};

export type ExecutionWarfareGuard = {
  action: "ALLOW" | "BLOCK";
  reasons: string[];
};

export type ExecutionWarfareSnapshot = {
  liquidity: LiquidityState;
  adversarialState: AdversarialMarketState;
  plan: ExecutionWarfarePlan;
  executionScore: number;
  guard: ExecutionWarfareGuard;
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeAverage(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function detectLiquidityTrap(input: {
  imbalance: number;
  absorption: number;
  hiddenLiquidity: number;
  tapeBuyPressure: number;
  tapeSellPressure: number;
}): "NORMAL" | "TRAP" {
  const buyTrap = input.imbalance < -0.22 && input.absorption > 0.55 && input.tapeBuyPressure > 0.58;
  const sellTrap = input.imbalance > 0.22 && input.absorption > 0.55 && input.tapeSellPressure > 0.58;
  const hiddenTrap = input.hiddenLiquidity > 0.68 && Math.abs(input.imbalance) > 0.18;
  return buyTrap || sellTrap || hiddenTrap ? "TRAP" : "NORMAL";
}

export function detectAdversarialFlow(input: {
  spoofProbability: number;
  sweepRisk: number;
  liquidity: number;
  trapState: "NORMAL" | "TRAP";
  microBurstRate: number;
}): AdversarialMarketState {
  if (input.trapState === "TRAP") {
    return "TRAP";
  }
  if (input.spoofProbability > 0.72) {
    return "SPOOF";
  }
  if (input.liquidity < 0.28) {
    return "LIQUIDITY_FADE";
  }
  if (input.sweepRisk > 0.7 || input.microBurstRate > 0.7) {
    return "STOP_HUNT";
  }
  return "NORMAL";
}

export function computeLatencyEdgeMs(input: {
  ownLatencyMs: number;
  marketLatencyMs: number;
}): number {
  return input.marketLatencyMs - input.ownLatencyMs;
}

export function executionScore(input: {
  fillProb: number;
  slippageBps: number;
  latencyEdgeMs: number;
  depthScore: number;
}): number {
  const fill = clamp(input.fillProb, 0, 1);
  const depth = clamp(input.depthScore, 0.05, 1);
  const slippageFactor = clamp(1 - input.slippageBps / 24, 0.08, 1);
  const latencyFactor = clamp(1 + input.latencyEdgeMs / 250, 0.45, 1.35);
  return clamp(fill * depth * slippageFactor * latencyFactor, 0, 1);
}

export function executionGuard(metrics: {
  fillProb: number;
  slippageBps: number;
  latencyMs: number;
  spoofProbability: number;
  sweepRisk: number;
}): ExecutionWarfareGuard {
  const reasons: string[] = [];
  if (metrics.slippageBps > 14) {
    reasons.push("warfare_slippage_high");
  }
  if (metrics.latencyMs > 220) {
    reasons.push("warfare_latency_high");
  }
  if (metrics.fillProb < 0.4) {
    reasons.push("warfare_fill_low");
  }
  if (metrics.spoofProbability > 0.82) {
    reasons.push("warfare_spoof_risk");
  }
  if (metrics.sweepRisk > 0.88) {
    reasons.push("warfare_sweep_risk");
  }
  return {
    action: reasons.length > 0 ? "BLOCK" : "ALLOW",
    reasons,
  };
}

export function sliceOrder(input: {
  notionalUsd: number;
  liquidity: number;
  mode: ExecutionWarfareMode;
}): { slices: number; sliceNotionalUsd: number } {
  const liquidityFactor = clamp(input.liquidity, 0.12, 1);
  const baseSlices = Math.ceil(1 / liquidityFactor);
  const modeBoost = input.mode === "STEALTH" ? 2 : input.mode === "PASSIVE" ? 1 : 0;
  const notionalCap = Math.max(1, Math.floor(input.notionalUsd / 75));
  const slices = clamp(Math.min(baseSlices + modeBoost, notionalCap), 1, 8);
  return {
    slices,
    sliceNotionalUsd: input.notionalUsd / slices,
  };
}

export function chooseVenue(candidates: WarfareVenueCandidate[]): WarfareVenueCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  return [...candidates].sort((left, right) => {
    const leftScore = (1 / Math.max(1, left.latencyMs)) * Math.max(1, left.depthUsd) * clamp(1 - left.spreadBps / 30, 0.05, 1) * clamp(left.fillProbability, 0.05, 1) * Math.max(0.05, left.score || 0.05);
    const rightScore = (1 / Math.max(1, right.latencyMs)) * Math.max(1, right.depthUsd) * clamp(1 - right.spreadBps / 30, 0.05, 1) * clamp(right.fillProbability, 0.05, 1) * Math.max(0.05, right.score || 0.05);
    return rightScore - leftScore;
  })[0] || null;
}

export function executionWarfareEngine(state: ExecutionWarfareState): ExecutionWarfareSnapshot {
  const trapState = detectLiquidityTrap({
    imbalance: state.imbalance,
    absorption: state.absorption,
    hiddenLiquidity: state.hiddenLiquidity,
    tapeBuyPressure: state.tapeBuyPressure,
    tapeSellPressure: state.tapeSellPressure,
  });
  const liquidityState: LiquidityState = {
    imbalance: state.imbalance,
    absorption: state.absorption,
    hiddenLiquidity: state.hiddenLiquidity,
    spoofProbability: state.spoofProbability,
    sweepRisk: state.sweepRisk,
    liquidityScore: state.liquidity,
    trapState,
  };
  const adversarialState = detectAdversarialFlow({
    spoofProbability: state.spoofProbability,
    sweepRisk: state.sweepRisk,
    liquidity: state.liquidity,
    trapState,
    microBurstRate: state.microBurstRate,
  });
  const venue = chooseVenue(state.venues);
  const effectiveLatencyMs = venue?.latencyMs || state.ownLatencyMs;
  const latencyEdgeMs = computeLatencyEdgeMs({
    ownLatencyMs: effectiveLatencyMs,
    marketLatencyMs: state.marketLatencyMs,
  });
  const score = executionScore({
    fillProb: state.fillProbability,
    slippageBps: state.slippageBps,
    latencyEdgeMs,
    depthScore: state.depthScore,
  });
  let mode: ExecutionWarfareMode = "PASSIVE";
  if ((state.volatility > 0.0065 && state.liquidity < 0.34) || adversarialState === "SPOOF" || adversarialState === "TRAP") {
    mode = "STEALTH";
  } else if ((state.imbalance > 0.55 || state.imbalance < -0.55) && state.fillProbability > 0.55 && score > 0.42) {
    mode = "AGGRESSIVE";
  }
  const slicing = sliceOrder({
    notionalUsd: Math.max(1, state.notionalUsd),
    liquidity: state.liquidity,
    mode,
  });
  const delayMs = Math.round(clamp(
    mode === "STEALTH"
      ? effectiveLatencyMs * 1.45 + state.sweepRisk * 40 + state.spoofProbability * 25
      : mode === "AGGRESSIVE"
        ? Math.max(5, effectiveLatencyMs * 0.8)
        : effectiveLatencyMs * 1.15 + state.sweepRisk * 18,
    5,
    180,
  ));
  const guard = executionGuard({
    fillProb: state.fillProbability,
    slippageBps: state.slippageBps,
    latencyMs: effectiveLatencyMs,
    spoofProbability: state.spoofProbability,
    sweepRisk: state.sweepRisk,
  });
  const reasons = [
    `mode:${mode.toLowerCase()}`,
    `adv:${adversarialState.toLowerCase()}`,
    `trap:${trapState.toLowerCase()}`,
    ...(guard.reasons.length > 0 ? guard.reasons : []),
  ];

  return {
    liquidity: liquidityState,
    adversarialState,
    plan: {
      venue: venue?.venue || "",
      mode,
      slices: slicing.slices,
      delayMs,
      sliceNotionalUsd: slicing.sliceNotionalUsd,
      latencyEdgeMs,
      maxSpreadMultiplier: mode === "AGGRESSIVE" ? 1.08 : mode === "STEALTH" ? 0.82 : 0.94,
    },
    executionScore: score,
    guard,
    reasons,
  };
}

export function averageVenueLatency(candidates: WarfareVenueCandidate[]): number {
  return safeAverage(candidates.map((candidate) => candidate.latencyMs), 0);
}