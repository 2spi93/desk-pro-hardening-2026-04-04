export type SmartMoneyInput = {
  absorption: number;
  deltaDivergence: number;
  priceStability: number;
  liquidityHold: number;
  volumeImpulse: number;
};

export type SmartMoneySignal = {
  state: "INACTIVE" | "WATCH" | "SMART_MONEY";
  confidence: number;
  score: number;
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function detectSmartMoney(input: SmartMoneyInput): SmartMoneySignal {
  const score = clamp(
    input.absorption * 0.32
      + input.deltaDivergence * 0.26
      + input.priceStability * 0.18
      + input.liquidityHold * 0.16
      + input.volumeImpulse * 0.08,
    0,
    1,
  );
  const reasons: string[] = [];
  if (input.absorption >= 0.55) reasons.push("absorption");
  if (input.deltaDivergence >= 0.55) reasons.push("delta_divergence");
  if (input.priceStability >= 0.55) reasons.push("price_stability");
  if (input.liquidityHold >= 0.5) reasons.push("liquidity_hold");
  if (input.volumeImpulse >= 0.45) reasons.push("volume_impulse");
  return {
    state: score >= 0.72 ? "SMART_MONEY" : score >= 0.45 ? "WATCH" : "INACTIVE",
    confidence: Number(score.toFixed(4)),
    score: Number(score.toFixed(4)),
    reasons,
  };
}