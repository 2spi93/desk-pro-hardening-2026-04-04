export type MicroAlphaSetupType = "absorption-reversal" | "breakout-initiation" | "fake-breakout-trap" | "none";
export type MicroAlphaDirection = "buy" | "sell" | "neutral";
export type MicroAlphaAction = "enter" | "breakout-enter" | "exit" | "reject" | "wait";

export type MicroAlphaDomLevel = {
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
};

export type MicroAlphaDomSnapshot = {
  spread: number;
  bestBid: number | null;
  bestAsk: number | null;
  depthBalance: number;
  liquidityScore: number;
  domDensity: number;
  bids: MicroAlphaDomLevel[];
  asks: MicroAlphaDomLevel[];
};

export type MicroAlphaFootprintLevel = {
  price: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  imbalance: number;
  intensity: number;
  stacked: boolean;
};

export type MicroAlphaFootprintSnapshot = {
  delta: number;
  totalDelta: number;
  cumulativeDelta: number;
  imbalance: number;
  absorption: boolean;
  stackedImbalance: boolean;
  exhaustion: boolean;
  liquidityTrap: boolean;
  orderflowQuality: number;
  spread: number;
  liquidityScore: number;
  absorptionProb: number;
  mlAbsorptionScore: number;
  strongSignal: boolean;
  domDensity: number;
  priceReaction: number;
  levels: MicroAlphaFootprintLevel[];
};

export type MicroAlphaBridge = {
  score: number;
  absorptionProb: number;
  domStrength: number;
  trendScore: number;
  trendDown: boolean;
  liquidityWallBelow: boolean;
  liquidityWallAbove: boolean;
  liquidityVacuum: boolean;
  spoofingRisk: boolean;
  volatilityBps: number;
  riskRejected: boolean;
};

export type MicroAlphaMarketMicro = {
  depthImbalance: number;
  cvdDelta: number;
  flowImbalance: number;
  tapeAcceleration: number;
  volatilityBps: number;
  spreadBps: number;
};

type MicroAlphaCandidate = {
  setupType: Exclude<MicroAlphaSetupType, "none">;
  direction: Exclude<MicroAlphaDirection, "neutral">;
  score: number;
  reasons: string[];
};

export type MicroAlphaSnapshot = {
  setupType: MicroAlphaSetupType;
  direction: MicroAlphaDirection;
  action: MicroAlphaAction;
  microScore: number;
  confidence: number;
  executable: boolean;
  rejectTrade: boolean;
  entrySignal: boolean;
  breakoutEntrySignal: boolean;
  exitSignal: boolean;
  liquidityWallBelow: boolean;
  liquidityWallAbove: boolean;
  liquidityVacuum: boolean;
  spoofingRisk: boolean;
  volatilityBps: number;
  reasons: string[];
  rejectionReasons: string[];
  familyScores: {
    absorptionReversal: number;
    breakoutInitiation: number;
    fakeBreakoutTrap: number;
  };
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeSigned(value: number): number {
  return clamp((value + 1) * 0.5, 0, 1);
}

function sumSideSize(levels: MicroAlphaDomLevel[], count: number): number {
  return levels.slice(0, count).reduce((sum, level) => sum + Math.max(0, level.size), 0);
}

function sideStackScore(levels: MicroAlphaDomLevel[]): number {
  const stackedCount = levels.slice(0, 5).filter((level) => level.intensity >= 0.72 || level.size >= 12).length;
  return clamp(stackedCount / 3, 0, 1);
}

function toMarketMicro(input?: Partial<MicroAlphaMarketMicro> | null): MicroAlphaMarketMicro {
  return {
    depthImbalance: clamp(Number(input?.depthImbalance) || 0, -1, 1),
    cvdDelta: Number(input?.cvdDelta) || 0,
    flowImbalance: clamp(Number(input?.flowImbalance) || 0, -1, 1),
    tapeAcceleration: clamp(Number(input?.tapeAcceleration) || 0, -1, 1),
    volatilityBps: Math.max(0, Number(input?.volatilityBps) || 0),
    spreadBps: Math.max(0, Number(input?.spreadBps) || 0),
  };
}

function pickBestCandidate(candidates: MicroAlphaCandidate[]): MicroAlphaCandidate | null {
  if (candidates.length === 0) {
    return null;
  }
  return [...candidates].sort((left, right) => right.score - left.score)[0] || null;
}

export function buildMicroAlphaSnapshot(input: {
  footprint: MicroAlphaFootprintSnapshot | null;
  dom: MicroAlphaDomSnapshot | null;
  bridge: MicroAlphaBridge;
  marketMicro?: Partial<MicroAlphaMarketMicro> | null;
}): MicroAlphaSnapshot {
  if (!input.footprint || !input.dom) {
    return {
      setupType: "none",
      direction: "neutral",
      action: "wait",
      microScore: 0,
      confidence: 0,
      executable: false,
      rejectTrade: true,
      entrySignal: false,
      breakoutEntrySignal: false,
      exitSignal: false,
      liquidityWallBelow: input.bridge.liquidityWallBelow,
      liquidityWallAbove: input.bridge.liquidityWallAbove,
      liquidityVacuum: input.bridge.liquidityVacuum,
      spoofingRisk: input.bridge.spoofingRisk,
      volatilityBps: input.bridge.volatilityBps,
      reasons: ["snapshot_unavailable"],
      rejectionReasons: ["snapshot_unavailable"],
      familyScores: {
        absorptionReversal: 0,
        breakoutInitiation: 0,
        fakeBreakoutTrap: 0,
      },
    };
  }

  const footprint = input.footprint;
  const dom = input.dom;
  const bridge = input.bridge;
  const marketMicro = toMarketMicro(input.marketMicro);
  const absorptionCore = clamp(
    Math.max(footprint.mlAbsorptionScore, footprint.absorptionProb, bridge.absorptionProb),
    0,
    1,
  );
  const domBuyPressure = clamp(
    normalizeSigned(dom.depthBalance) * 0.7
      + clamp(sumSideSize(dom.bids, 3) / Math.max(1, sumSideSize(dom.bids, 3) + sumSideSize(dom.asks, 3)), 0, 1) * 0.3,
    0,
    1,
  );
  const domSellPressure = clamp(1 - domBuyPressure, 0, 1);
  const flowBuyPressure = clamp(
    normalizeSigned(footprint.imbalance) * 0.5
      + normalizeSigned(marketMicro.flowImbalance) * 0.25
      + normalizeSigned(marketMicro.depthImbalance) * 0.15
      + (marketMicro.cvdDelta > 0 ? 0.1 : 0),
    0,
    1,
  );
  const flowSellPressure = clamp(1 - flowBuyPressure, 0, 1);
  const supportLiquidity = clamp(
    (bridge.liquidityWallBelow ? 0.7 : 0)
      + sideStackScore(dom.bids) * 0.3,
    0,
    1,
  );
  const resistanceLiquidity = clamp(
    (bridge.liquidityWallAbove ? 0.7 : 0)
      + sideStackScore(dom.asks) * 0.3,
    0,
    1,
  );
  const liquidityQuality = clamp(
    dom.liquidityScore * 0.55 + footprint.liquidityScore * 0.25 + dom.domDensity * 0.2,
    0,
    1,
  );
  const priceAcceptance = clamp((0.0014 - Math.abs(footprint.priceReaction)) / 0.0014, 0, 1);
  const spoofPenalty = bridge.spoofingRisk ? 0.12 : 0;
  const vacuumPenalty = bridge.liquidityVacuum ? 0.12 : 0;
  const breakoutBoost = bridge.liquidityVacuum ? 0.1 : 0;
  const accelerationBuy = marketMicro.tapeAcceleration > 0 ? clamp(marketMicro.tapeAcceleration, 0, 1) : 0;
  const accelerationSell = marketMicro.tapeAcceleration < 0 ? clamp(Math.abs(marketMicro.tapeAcceleration), 0, 1) : 0;
  const trendUp = !bridge.trendDown && (marketMicro.cvdDelta > 0 || marketMicro.depthImbalance > 0);

  const candidates: MicroAlphaCandidate[] = [
    {
      setupType: "absorption-reversal",
      direction: "buy",
      score: clamp(
        absorptionCore * 0.34
          + flowSellPressure * 0.18
          + supportLiquidity * 0.18
          + (bridge.trendDown ? 0.1 : 0)
          + (footprint.exhaustion ? 0.08 : 0)
          + liquidityQuality * 0.08
          + priceAcceptance * 0.08
          - vacuumPenalty
          - spoofPenalty,
        0,
        1,
      ),
      reasons: ["absorption", "sell_pressure_absorbed", "support_liquidity"],
    },
    {
      setupType: "absorption-reversal",
      direction: "sell",
      score: clamp(
        absorptionCore * 0.34
          + flowBuyPressure * 0.18
          + resistanceLiquidity * 0.18
          + (trendUp ? 0.1 : 0)
          + (footprint.exhaustion ? 0.08 : 0)
          + liquidityQuality * 0.08
          + priceAcceptance * 0.08
          - vacuumPenalty
          - spoofPenalty,
        0,
        1,
      ),
      reasons: ["absorption", "buy_pressure_absorbed", "resistance_liquidity"],
    },
    {
      setupType: "breakout-initiation",
      direction: "buy",
      score: clamp(
        flowBuyPressure * 0.24
          + domBuyPressure * 0.18
          + (footprint.stackedImbalance ? 0.12 : 0)
          + footprint.orderflowQuality * 0.12
          + liquidityQuality * 0.08
          + (!bridge.liquidityWallAbove ? 0.1 : 0)
          + breakoutBoost
          + accelerationBuy * 0.06
          - spoofPenalty,
        0,
        1,
      ),
      reasons: ["aggressive_buy_flow", "stacked_imbalance", "ask_side_open"],
    },
    {
      setupType: "breakout-initiation",
      direction: "sell",
      score: clamp(
        flowSellPressure * 0.24
          + domSellPressure * 0.18
          + (footprint.stackedImbalance ? 0.12 : 0)
          + footprint.orderflowQuality * 0.12
          + liquidityQuality * 0.08
          + (!bridge.liquidityWallBelow ? 0.1 : 0)
          + breakoutBoost
          + accelerationSell * 0.06
          - spoofPenalty,
        0,
        1,
      ),
      reasons: ["aggressive_sell_flow", "stacked_imbalance", "bid_side_open"],
    },
    {
      setupType: "fake-breakout-trap",
      direction: "buy",
      score: clamp(
        (footprint.liquidityTrap ? 0.24 : 0)
          + supportLiquidity * 0.16
          + (bridge.spoofingRisk ? 0.16 : 0)
          + flowSellPressure * 0.12
          + absorptionCore * 0.1
          + (bridge.liquidityVacuum ? 0.08 : 0)
          + (footprint.exhaustion ? 0.08 : 0)
          + priceAcceptance * 0.06,
        0,
        1,
      ),
      reasons: ["trap_detected", "support_holds", "short_breakout_failed"],
    },
    {
      setupType: "fake-breakout-trap",
      direction: "sell",
      score: clamp(
        (footprint.liquidityTrap ? 0.24 : 0)
          + resistanceLiquidity * 0.16
          + (bridge.spoofingRisk ? 0.16 : 0)
          + flowBuyPressure * 0.12
          + absorptionCore * 0.1
          + (bridge.liquidityVacuum ? 0.08 : 0)
          + (footprint.exhaustion ? 0.08 : 0)
          + priceAcceptance * 0.06,
        0,
        1,
      ),
      reasons: ["trap_detected", "resistance_holds", "long_breakout_failed"],
    },
  ];

  const bestCandidate = pickBestCandidate(candidates);
  const sortedCandidates = [...candidates].sort((left, right) => right.score - left.score);
  const runnerUpScore = sortedCandidates[1]?.score || 0;
  const familyScores = {
    absorptionReversal: Math.max(...candidates.filter((item) => item.setupType === "absorption-reversal").map((item) => item.score), 0),
    breakoutInitiation: Math.max(...candidates.filter((item) => item.setupType === "breakout-initiation").map((item) => item.score), 0),
    fakeBreakoutTrap: Math.max(...candidates.filter((item) => item.setupType === "fake-breakout-trap").map((item) => item.score), 0),
  };

  if (!bestCandidate) {
    return {
      setupType: "none",
      direction: "neutral",
      action: "wait",
      microScore: 0,
      confidence: 0,
      executable: false,
      rejectTrade: true,
      entrySignal: false,
      breakoutEntrySignal: false,
      exitSignal: false,
      liquidityWallBelow: bridge.liquidityWallBelow,
      liquidityWallAbove: bridge.liquidityWallAbove,
      liquidityVacuum: bridge.liquidityVacuum,
      spoofingRisk: bridge.spoofingRisk,
      volatilityBps: bridge.volatilityBps,
      reasons: ["no_candidate"],
      rejectionReasons: ["no_candidate"],
      familyScores,
    };
  }

  const microScore = clamp(
    bestCandidate.score * 0.72 + runnerUpScore * 0.18 + liquidityQuality * 0.1,
    0,
    1,
  );
  const confidence = clamp(
    bestCandidate.score * 0.74 + Math.max(0, bestCandidate.score - runnerUpScore) * 0.26,
    0,
    1,
  );
  const rejectionReasons: string[] = [];
  if (bridge.riskRejected && bestCandidate.setupType !== "fake-breakout-trap") {
    rejectionReasons.push("bridge_risk_reject");
  }
  if (bridge.liquidityVacuum && bestCandidate.setupType === "absorption-reversal") {
    rejectionReasons.push("vacuum_blocks_reversal");
  }
  if (bridge.spoofingRisk && bestCandidate.setupType !== "fake-breakout-trap") {
    rejectionReasons.push("spoofing_risk");
  }
  if (marketMicro.spreadBps >= 12) {
    rejectionReasons.push("spread_too_wide");
  }
  if (microScore < 0.6) {
    rejectionReasons.push("score_below_threshold");
  }
  if (liquidityQuality < 0.3) {
    rejectionReasons.push("thin_liquidity");
  }

  const action: MicroAlphaAction = bestCandidate.setupType === "absorption-reversal"
    ? "enter"
    : bestCandidate.setupType === "breakout-initiation"
      ? "breakout-enter"
      : "exit";
  const rejectTrade = action !== "exit" && rejectionReasons.length > 0;
  const executable = !rejectTrade && (action === "enter" || action === "breakout-enter") && confidence >= 0.62;
  const reasons = Array.from(new Set([
    ...bestCandidate.reasons,
    `${bestCandidate.setupType}:${bestCandidate.direction}`,
    bridge.liquidityWallBelow ? "wall_below" : "",
    bridge.liquidityWallAbove ? "wall_above" : "",
    bridge.liquidityVacuum ? "liquidity_vacuum" : "",
    bridge.spoofingRisk ? "spoofing" : "",
  ].filter(Boolean)));

  return {
    setupType: bestCandidate.setupType,
    direction: bestCandidate.direction,
    action: rejectTrade ? "reject" : action,
    microScore,
    confidence,
    executable,
    rejectTrade,
    entrySignal: executable && action === "enter",
    breakoutEntrySignal: executable && action === "breakout-enter",
    exitSignal: bestCandidate.setupType === "fake-breakout-trap" && microScore >= 0.58,
    liquidityWallBelow: bridge.liquidityWallBelow,
    liquidityWallAbove: bridge.liquidityWallAbove,
    liquidityVacuum: bridge.liquidityVacuum,
    spoofingRisk: bridge.spoofingRisk,
    volatilityBps: Math.max(bridge.volatilityBps, marketMicro.volatilityBps),
    reasons,
    rejectionReasons,
    familyScores,
  };
}