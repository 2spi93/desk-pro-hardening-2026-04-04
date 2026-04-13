export type ExecutionRlPolicy = {
  aggression: number;
  sliceSize: number;
  delayMs: number;
};

export type ExecutionRlResult = {
  slippageBps: number;
  fillRate: number;
  latencyMs: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function defaultExecutionRlPolicy(): ExecutionRlPolicy {
  return {
    aggression: 0.5,
    sliceSize: 0.3,
    delayMs: 50,
  };
}

export function updateExecutionRlPolicy(policy: ExecutionRlPolicy, result: ExecutionRlResult, targetSlippageBps = 4): ExecutionRlPolicy {
  const slippageDelta = result.slippageBps <= targetSlippageBps ? 0.05 : -0.06;
  const fillDelta = result.fillRate >= 0.92 ? 0.04 : result.fillRate >= 0.75 ? 0.01 : -0.05;
  const latencyDelta = result.latencyMs <= 80 ? -8 : result.latencyMs <= 180 ? 0 : 12;
  return {
    aggression: clamp(policy.aggression + slippageDelta + fillDelta * 0.4, 0.1, 1),
    sliceSize: clamp(policy.sliceSize + fillDelta * 0.18 - Math.max(0, result.slippageBps - targetSlippageBps) * 0.01, 0.1, 1),
    delayMs: clamp(policy.delayMs + latencyDelta, 10, 250),
  };
}