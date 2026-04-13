export type MarketStateInput = {
  trendStrength: number;
  volatility: number;
  liquidityScore: number;
  spoofState: "CLEAR" | "WATCH" | "SPOOF";
  smartMoneyState: "INACTIVE" | "WATCH" | "SMART_MONEY";
  trapProbability: number;
};

export type MarketStateSignal = {
  state: "TREND" | "CHOP" | "TRAP" | "HIGH_VOL" | "DEAD";
  confidence: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function classifyMarketState(input: MarketStateInput): MarketStateSignal {
  const volatility = clamp(input.volatility, 0, 1);
  const trendStrength = clamp(input.trendStrength, 0, 1);
  const liquidityScore = clamp(input.liquidityScore, 0, 1);
  const trapProbability = clamp(input.trapProbability, 0, 1);
  if (input.spoofState === "SPOOF" || trapProbability >= 0.72) {
    return { state: "TRAP", confidence: Number(Math.max(trapProbability, 0.72).toFixed(4)) };
  }
  if (volatility >= 0.72) {
    return { state: "HIGH_VOL", confidence: Number(volatility.toFixed(4)) };
  }
  if (liquidityScore <= 0.28) {
    return { state: "DEAD", confidence: Number((1 - liquidityScore).toFixed(4)) };
  }
  if (trendStrength >= 0.62 || input.smartMoneyState === "SMART_MONEY") {
    return { state: "TREND", confidence: Number(Math.max(trendStrength, 0.62).toFixed(4)) };
  }
  return { state: "CHOP", confidence: Number((0.45 + (1 - trendStrength) * 0.2).toFixed(4)) };
}