export type SpoofDetectionInput = {
  largeOrdersRemovedRatio: number;
  liquidityFakeScore: number;
  reversalSpeed: number;
  tradeFollowThrough: number;
  cancelVelocity: number;
};

export type SpoofDetectionSignal = {
  state: "CLEAR" | "WATCH" | "SPOOF";
  score: number;
  reasons: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function detectSpoofing(input: SpoofDetectionInput): SpoofDetectionSignal {
  const lowFollowThrough = 1 - clamp(input.tradeFollowThrough, 0, 1);
  const score = clamp(
    input.largeOrdersRemovedRatio * 0.28
      + input.liquidityFakeScore * 0.24
      + input.reversalSpeed * 0.2
      + lowFollowThrough * 0.16
      + input.cancelVelocity * 0.12,
    0,
    1,
  );
  const reasons: string[] = [];
  if (input.largeOrdersRemovedRatio >= 0.55) reasons.push("large_orders_removed");
  if (input.liquidityFakeScore >= 0.55) reasons.push("fake_liquidity");
  if (input.reversalSpeed >= 0.5) reasons.push("fast_reversal");
  if (lowFollowThrough >= 0.55) reasons.push("no_trade_follow_through");
  if (input.cancelVelocity >= 0.55) reasons.push("cancel_velocity");
  return {
    state: score >= 0.7 ? "SPOOF" : score >= 0.45 ? "WATCH" : "CLEAR",
    score: Number(score.toFixed(4)),
    reasons,
  };
}