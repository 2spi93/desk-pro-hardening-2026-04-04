import { expect, test } from "@playwright/test";

import {
  buildExecutionV7LiteContext,
  buildExecutionV7LiteAttempt,
  buildExecutionV7LitePlan,
  buildExecutionV7LiteVenueLearningProfile,
  createExecutionV7LiteIntent,
  evaluateExecutionV7LiteSmartGate,
  evaluateExecutionV7LiteContinuation,
  finalizeExecutionV7LiteResult,
} from "../../app/terminal/executionV7LiteEngine";

test("execution v7 lite aggregates partial fills across follow-ups precisely", () => {
  const intent = createExecutionV7LiteIntent({
    symbol: "BTCUSDT",
    side: "buy",
    requestedNotionalUsd: 100,
    effectiveNotionalUsd: 100,
    preferredVenue: "binance",
    maxSpreadBps: 3,
    slippageBudgetBps: 4,
    expectedSlippageBps: 1.8,
    latencyGuardMs: 120,
    requestedSlices: 1,
    partialFillAction: "cancel_replace",
    partialFillTargetRatio: 0.8,
    expectedFillRatio: 0.82,
    maxRetries: 1,
  });
  const plan = buildExecutionV7LitePlan({
    intent,
    slices: [{ id: "slice-1", venue: "binance", notionalUsd: 100, plannedDelayMs: 0, state: "planned", replaceCount: 1, resliceEligible: false }],
  });
  const attempt = buildExecutionV7LiteAttempt({
    slice: plan.slices[0],
    status: "partial",
    fillRatio: 0.4,
    latencyMs: 55,
    realizedSlippageBps: 1.2,
    followUps: [{
      type: "cancel_replace",
      status: "filled",
      fillRatio: 0.5,
      latencyMs: 72,
      realizedSlippageBps: 2.1,
    }],
  });
  const result = finalizeExecutionV7LiteResult({
    plan,
    attempts: [attempt],
  });

  expect(attempt.executedNotionalUsd).toBeCloseTo(70, 6);
  expect(result.fillRatio).toBeCloseTo(0.7, 6);
  expect(result.status).toBe("partial");
  expect(result.feedback.failureSource).toBe("partial_fill");
  expect(result.followUpCount).toBe(1);
});

test("execution v7 lite smart gate delays and reduces size under stressed microstructure", () => {
  const intent = createExecutionV7LiteIntent({
    symbol: "BTCUSDT",
    side: "buy",
    requestedNotionalUsd: 250,
    effectiveNotionalUsd: 250,
    preferredVenue: "binance",
    maxSpreadBps: 4,
    slippageBudgetBps: 4,
    expectedSlippageBps: 1.6,
    latencyGuardMs: 120,
    requestedSlices: 2,
    partialFillAction: "reslice",
    partialFillTargetRatio: 0.72,
    expectedFillRatio: 0.76,
  });
  const context = buildExecutionV7LiteContext({
    spreadBps: 3.6,
    volatilityBps: 18,
    liquidityScore: 0.42,
    microTrend: "flat",
    flowImbalance: 0.08,
    spoofingScore: 0.44,
    expectedLatencyMs: 92,
    queuePressure: 0.68,
    marketPressure: "neutral",
  });
  const venueLearning = buildExecutionV7LiteVenueLearningProfile({
    venue: "binance",
    samples: 8,
    avgLatencyMs: 70,
    avgSlippageBps: 2.6,
    fillRatio: 0.74,
    rejectRate: 0.08,
  });
  const gate = evaluateExecutionV7LiteSmartGate({ intent, context, venueLearning });

  expect(gate.allow).toBe(true);
  expect(gate.recommendedDelayMs).toBeGreaterThan(0);
  expect(gate.sizeMultiplier).toBeLessThan(1);
  expect(gate.executionScore).toBeLessThan(0.78);
});

test("execution v7 lite stops remaining slices when slippage guard is breached", () => {
  const intent = createExecutionV7LiteIntent({
    symbol: "ETHUSDT",
    side: "sell",
    requestedNotionalUsd: 300,
    effectiveNotionalUsd: 300,
    preferredVenue: "bingx",
    maxSpreadBps: 4,
    slippageBudgetBps: 3,
    expectedSlippageBps: 1.5,
    latencyGuardMs: 150,
    requestedSlices: 3,
    partialFillAction: "reslice",
    partialFillTargetRatio: 0.72,
    expectedFillRatio: 0.76,
  });
  const plan = buildExecutionV7LitePlan({
    intent,
    slices: [
      { id: "slice-1", venue: "bingx", notionalUsd: 100, plannedDelayMs: 0, state: "planned", replaceCount: 0, resliceEligible: true },
      { id: "slice-2", venue: "bingx", notionalUsd: 100, plannedDelayMs: 35, state: "planned", replaceCount: 0, resliceEligible: true },
      { id: "slice-3", venue: "bingx", notionalUsd: 100, plannedDelayMs: 35, state: "planned", replaceCount: 0, resliceEligible: true },
    ],
  });
  const attempt = buildExecutionV7LiteAttempt({
    slice: plan.slices[0],
    status: "partial",
    fillRatio: 0.2,
    latencyMs: 88,
    realizedSlippageBps: 4.4,
  });
  const decision = evaluateExecutionV7LiteContinuation({
    plan,
    attempts: [attempt],
  });
  const result = finalizeExecutionV7LiteResult({
    plan,
    attempts: [attempt],
    stopReason: decision.reason,
  });

  expect(decision.shouldContinue).toBe(false);
  expect(decision.reason).toBe("slippage_guard");
  expect(result.slippageGuardTriggered).toBe(true);
  expect(result.feedback.failureSource).toBe("slippage_guard");
});

test("execution v7 lite smart gate blocks when liquidity is thin and spread blows out", () => {
  const intent = createExecutionV7LiteIntent({
    symbol: "ETHUSDT",
    side: "sell",
    requestedNotionalUsd: 120,
    effectiveNotionalUsd: 120,
    preferredVenue: "bybit",
    maxSpreadBps: 2.5,
    slippageBudgetBps: 3,
    expectedSlippageBps: 1.4,
    latencyGuardMs: 100,
    requestedSlices: 1,
  });
  const context = buildExecutionV7LiteContext({
    spreadBps: 3.1,
    volatilityBps: 22,
    liquidityScore: 0.1,
    microTrend: "up",
    flowImbalance: 0.34,
    spoofingScore: 0.92,
    expectedLatencyMs: 138,
    queuePressure: 0.9,
    marketPressure: "buy",
  });
  const venueLearning = buildExecutionV7LiteVenueLearningProfile({
    venue: "bybit",
    samples: 10,
    avgLatencyMs: 130,
    avgSlippageBps: 5.4,
    fillRatio: 0.41,
    rejectRate: 0.22,
  });
  const gate = evaluateExecutionV7LiteSmartGate({ intent, context, venueLearning });

  expect(gate.allow).toBe(false);
  expect(gate.reasons).toContain("spread_expanding");
  expect(gate.reasons).toContain("liquidity_thin");
  expect(gate.reasons).toContain("spoofing_risk");
});