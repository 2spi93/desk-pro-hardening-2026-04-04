import assert from "node:assert/strict";

import { buildTerminalAdaptiveGuide } from "../../app/terminal/terminalAdaptiveGuide";
import type { FeedbackSummary } from "../../app/terminal/feedbackEngine";
import type { SmartDecisionHudShape } from "../../app/terminal/chartHudTypes";

function createFeedbackSummary(overrides: Partial<FeedbackSummary> = {}): FeedbackSummary {
  return {
    tradeCount: 0,
    tradeQualityCounts: {
      GOOD_EXECUTION: 0,
      BAD_EXECUTION: 0,
      GOOD_NO_TRADE: 0,
      MISSED_OPPORTUNITY: 0,
      MODEL_ERROR: 0,
      MARKET_NOISE: 0,
    },
    dominantTradeQuality: "MARKET_NOISE",
    modelHealth: "ADAPTING",
    driftState: "CALM",
    errors: [],
    reward: {
      rawScore: 0,
      scorePct: 50,
      normalizedPnl: 0,
      fillEfficiency: 0.7,
      slippageQuality: 0.7,
      decisionQuality: 0.7,
      riskPenalty: 0.1,
      behaviorScore: 0.8,
      regimeBonus: 0,
      regimeBiasLabel: "reward neutral",
    },
    shield: {
      learningState: "ACTIVE",
      freezeLearning: false,
      explorationMode: "minimal",
      multiRegimeValidation: "PASS",
      rollingRealityRatio: 0.92,
      contextCompression: "normal",
      reasons: [],
    },
    calibrationActions: [],
    windows: [],
    recommendations: [],
    protections: [],
    reduceSize: false,
    forceNoTrade: false,
    learningDisabled: false,
    maxAdjustmentPerDayPct: 5,
    ...overrides,
  };
}

function createSmartDecision(overrides: Partial<SmartDecisionHudShape> = {}): SmartDecisionHudShape {
  return {
    state: "WAIT_CONFIRMATION",
    stateLabel: "WAIT_CONFIRMATION",
    displayStateLabel: "WAIT CONFIRMATION",
    headline: "Attendre la confirmation",
    reason: "Le signal n'est pas encore stable.",
    compactLabel: "WAIT",
    assistantSummary: "Attendre.",
    tone: "subtle",
    confidencePct: 58,
    qualityGate: "warn",
    qualityGateLabel: "warning",
    confidenceBand: "MEDIUM",
    regimeLabel: "BALANCED",
    structureLabel: "Neutral",
    liquidityLabel: "Normal",
    triggerSide: "neutral",
    triggerLabel: "trigger pending",
    invalidationLabel: "invalidation pending",
    latencyLabel: "180 ms",
    stability: {
      currentStateLabel: "WAIT_CONFIRMATION",
      lastStableStateLabel: "NO_TRADE",
      stabilityScorePct: 44,
      statusLabel: "warming up",
      isStable: false,
      persistenceMs: 350,
      persistenceLabel: "350 ms",
      flipCount: 0,
      confidenceBand: "MEDIUM",
    },
    ...overrides,
  };
}

const readGuide = buildTerminalAdaptiveGuide({
  smartDecision: null,
  feedbackSummary: createFeedbackSummary(),
});

assert.equal(readGuide.recommendedMode, "READ_MARKET", "missing decision context should default to market reading");
assert.equal(readGuide.disciplineLock, false, "plain observation mode should not hard lock discipline");
assert.equal(readGuide.assistanceLevel, "MEDIUM", "without strong history the guide should stay visible but not maximal");

const executeGuide = buildTerminalAdaptiveGuide({
  smartDecision: createSmartDecision({
    state: "ENTRY_VALID",
    qualityGate: "pass",
    stability: {
      currentStateLabel: "ENTRY_VALID",
      lastStableStateLabel: "ENTRY_VALID",
      stabilityScorePct: 88,
      statusLabel: "stable",
      isStable: true,
      persistenceMs: 1400,
      persistenceLabel: "1.4 s",
      flipCount: 0,
      confidenceBand: "HIGH",
    },
  }),
  feedbackSummary: createFeedbackSummary({
    tradeCount: 6,
    tradeQualityCounts: {
      GOOD_EXECUTION: 4,
      BAD_EXECUTION: 0,
      GOOD_NO_TRADE: 1,
      MISSED_OPPORTUNITY: 0,
      MODEL_ERROR: 0,
      MARKET_NOISE: 1,
    },
    dominantTradeQuality: "GOOD_EXECUTION",
    modelHealth: "HEALTHY",
    reward: {
      rawScore: 0.48,
      scorePct: 72,
      normalizedPnl: 0.4,
      fillEfficiency: 0.86,
      slippageQuality: 0.84,
      decisionQuality: 0.81,
      riskPenalty: 0.08,
      behaviorScore: 0.92,
      regimeBonus: 0.05,
      regimeBiasLabel: "reward breakout bonus",
    },
  }),
});

assert.equal(executeGuide.recommendedMode, "EXECUTE_SAFE", "stable entry plus healthy feedback should route to execute-safe");
assert.equal(executeGuide.disciplineLock, false, "clean execute-safe path should remain open");
assert.equal(executeGuide.assistanceLevel, "LOW", "clean recent behavior should reduce guide intensity");

const calibrateGuide = buildTerminalAdaptiveGuide({
  smartDecision: createSmartDecision({
    state: "ENTRY_VALID",
    qualityGate: "warn",
    stability: {
      currentStateLabel: "ENTRY_VALID",
      lastStableStateLabel: "WAIT_CONFIRMATION",
      stabilityScorePct: 24,
      statusLabel: "unstable",
      isStable: false,
      persistenceMs: 200,
      persistenceLabel: "200 ms",
      flipCount: 3,
      confidenceBand: "LOW",
    },
  }),
  feedbackSummary: createFeedbackSummary({
    tradeCount: 8,
    modelHealth: "BROKEN",
    driftState: "LOCK",
    forceNoTrade: true,
    learningDisabled: true,
    protections: ["force_no_trade", "disable_learning"],
    shield: {
      learningState: "FROZEN",
      freezeLearning: true,
      explorationMode: "frozen",
      multiRegimeValidation: "REJECT",
      rollingRealityRatio: 0.41,
      contextCompression: "compressed",
      reasons: ["positive pnl concentrated in one regime only"],
    },
    calibrationActions: [
      { target: "confidence_threshold", direction: "increase", magnitudePct: 2.5, reason: "prediction error elevated" },
    ],
  }),
});

assert.equal(calibrateGuide.recommendedMode, "CALIBRATE", "broken discipline and lock drift should route to calibration");
assert.equal(calibrateGuide.disciplineLock, true, "force-no-trade and learning-disabled should hard lock discipline");
assert.equal(calibrateGuide.disciplineReason, "force_no_trade", "the first active hard protection should explain the lock");
assert.equal(calibrateGuide.assistanceLevel, "HIGH", "discipline lock should force maximal assistance");

const journalDrivenGuide = buildTerminalAdaptiveGuide({
  smartDecision: createSmartDecision(),
  feedbackSummary: createFeedbackSummary({
    tradeCount: 4,
    modelHealth: "ADAPTING",
    reward: {
      rawScore: 0.11,
      scorePct: 52,
      normalizedPnl: 0.1,
      fillEfficiency: 0.7,
      slippageQuality: 0.72,
      decisionQuality: 0.64,
      riskPenalty: 0.14,
      behaviorScore: 0.58,
      regimeBonus: 0,
      regimeBiasLabel: "reward neutral",
    },
  }),
  journalEntries: [
    { action: "override-visible-on", createdAtIso: "2026-04-12T10:00:00.000Z" },
    { action: "auto-reduce", createdAtIso: "2026-04-12T10:30:00.000Z" },
  ],
  nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
});

assert.equal(journalDrivenGuide.assistanceLevel, "HIGH", "recent override and forced protection should increase assistance");
assert.match(journalDrivenGuide.assistanceReason, /recent operator error/i, "assistance reason should explain recent operator friction");

console.log("PASS terminal-adaptive-guide regression: onboarding routes between read, execute and calibrate using decision and Bloc 5 feedback");