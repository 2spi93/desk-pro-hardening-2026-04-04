export type PortfolioAllocatorStrategyInput = {
  id: string;
  expectancy: number;
  sharpe: number;
  drawdown: number;
  winrate?: number;
  sampleSize?: number;
  status?: string | null;
  regimeMultiplier?: number;
};

export type PortfolioAllocatorEntry = PortfolioAllocatorStrategyInput & {
  score: number;
  allocation: number;
  blocked: boolean;
  reasons: string[];
};

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function safeNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeExpectancy(value: number, scale: number): number {
  return Math.tanh(safeNumber(value, 0) / Math.max(1, scale));
}

function normalizeSharpe(value: number): number {
  return Math.tanh(safeNumber(value, 0) / 2);
}

export function computeStrategyScore(strategy: PortfolioAllocatorStrategyInput, expectancyScale = 50): number {
  const expectancyScore = normalizeExpectancy(strategy.expectancy, expectancyScale);
  const sharpeScore = normalizeSharpe(strategy.sharpe);
  const drawdownScore = clamp(strategy.drawdown, 0, 1);
  const regimeMultiplier = clamp(strategy.regimeMultiplier ?? 1, 0, 2);
  return (expectancyScore * 0.4 + sharpeScore * 0.3 - drawdownScore * 0.3) * regimeMultiplier;
}

export function allocateCapital(
  strategies: PortfolioAllocatorStrategyInput[],
  options?: { drawdownKillThreshold?: number },
): PortfolioAllocatorEntry[] {
  const drawdownKillThreshold = clamp(options?.drawdownKillThreshold ?? 0.1, 0.02, 0.5);
  const expectancyScale = Math.max(
    25,
    ...strategies.map((strategy) => Math.abs(safeNumber(strategy.expectancy, 0))),
  );

  const scored = strategies.map((strategy) => {
    const drawdown = clamp(strategy.drawdown, 0, 1);
    const regimeMultiplier = clamp(strategy.regimeMultiplier ?? 1, 0, 2);
    const blocked = drawdown >= drawdownKillThreshold || strategy.status === "demote" || regimeMultiplier <= 0.05;
    const reasons: string[] = [];
    if (drawdown >= drawdownKillThreshold) {
      reasons.push("drawdown_kill");
    }
    if (strategy.status === "demote") {
      reasons.push("strategy_demoted");
    }
    if (regimeMultiplier <= 0.05) {
      reasons.push("regime_block");
    }
    const score = blocked ? 0 : Math.max(0, computeStrategyScore(strategy, expectancyScale));
    return {
      ...strategy,
      score,
      allocation: 0,
      blocked,
      reasons,
    } satisfies PortfolioAllocatorEntry;
  });

  const active = scored.filter((strategy) => !strategy.blocked);
  const totalScore = active.reduce((sum, strategy) => sum + strategy.score, 0);
  const equalWeight = active.length > 0 ? 1 / active.length : 0;

  return scored
    .map((strategy) => ({
      ...strategy,
      allocation: strategy.blocked
        ? 0
        : totalScore > 0
          ? strategy.score / totalScore
          : equalWeight,
    }))
    .sort((left, right) => right.allocation - left.allocation || right.score - left.score);
}

export function deriveAllocatorSizeMultiplier(entries: PortfolioAllocatorEntry[], strategyId?: string | null): number {
  const active = entries.filter((entry) => !entry.blocked);
  if (active.length === 0) {
    return 1;
  }
  const selected = active.find((entry) => entry.id === strategyId) || active[0];
  const equalWeight = 1 / active.length;
  return clamp(selected.allocation / Math.max(equalWeight, 1e-9), 0.2, 1.25);
}