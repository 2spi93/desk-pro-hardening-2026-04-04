import assert from "node:assert/strict";

import { resolveSmartDecision } from "../../app/terminal/decisionEngine";
import { detectLiquidity } from "../../app/terminal/liquidityEngine";
import { buildRegimeSnapshot } from "../../app/terminal/regimeEngine";
import { detectStructure } from "../../app/terminal/structureEngine";

const bullCandles = [
  { label: "2026-04-12T09:00:00.000Z", open: 100, high: 101.5, low: 99.6, close: 101.2, volume: 12 },
  { label: "2026-04-12T09:01:00.000Z", open: 101.2, high: 101.4, low: 100.7, close: 100.95, volume: 9 },
  { label: "2026-04-12T09:02:00.000Z", open: 100.95, high: 102.2, low: 100.8, close: 102.0, volume: 14 },
  { label: "2026-04-12T09:03:00.000Z", open: 102.0, high: 102.1, low: 101.3, close: 101.55, volume: 10 },
  { label: "2026-04-12T09:04:00.000Z", open: 101.55, high: 103.0, low: 101.4, close: 102.8, volume: 18 },
  { label: "2026-04-12T09:05:00.000Z", open: 102.8, high: 102.95, low: 102.15, close: 102.4, volume: 11 },
  { label: "2026-04-12T09:06:00.000Z", open: 102.4, high: 103.7, low: 102.25, close: 103.5, volume: 19 },
  { label: "2026-04-12T09:07:00.000Z", open: 103.5, high: 103.65, low: 102.9, close: 103.15, volume: 12 },
  { label: "2026-04-12T09:08:00.000Z", open: 103.15, high: 104.1, low: 103.0, close: 103.95, volume: 21 },
  { label: "2026-04-12T09:09:00.000Z", open: 103.95, high: 104.8, low: 103.8, close: 104.65, volume: 24 },
  { label: "2026-04-12T09:10:00.000Z", open: 104.65, high: 105.3, low: 104.5, close: 105.05, volume: 26 },
  { label: "2026-04-12T09:11:00.000Z", open: 105.05, high: 105.65, low: 104.95, close: 105.45, volume: 28 },
];

const bullStructure = detectStructure(bullCandles);
const bullRegime = buildRegimeSnapshot(bullCandles);
const bullLiquidity = detectLiquidity(bullCandles, bullStructure);

assert.equal(bullRegime.state, "BULL", "aligned higher-horizon uptrend should resolve as a bull regime");

const bullDecision = resolveSmartDecision({
  regime: bullRegime,
  structure: bullStructure,
  liquidity: bullLiquidity,
  predictionDirection: "LONG",
  predictionProbability: 78,
  predictionTrigger: 105.6,
  predictionInvalidation: 104.1,
  lowFlowEdgeBlocked: false,
  routeScorePct: 72,
  domImbalance: 0.21,
  decisionLatencyMs: 180,
});

assert.equal(bullDecision.state, "ENTRY_VALID", "aligned bull regime with clean structure should validate entry");

const fakeBreakoutCandles = [
  { label: "2026-04-12T11:00:00.000Z", open: 100, high: 102, low: 99.7, close: 101.6, volume: 10 },
  { label: "2026-04-12T11:01:00.000Z", open: 101.6, high: 102.8, low: 101.2, close: 102.5, volume: 12 },
  { label: "2026-04-12T11:02:00.000Z", open: 102.5, high: 103.9, low: 102.2, close: 103.6, volume: 15 },
  { label: "2026-04-12T11:03:00.000Z", open: 103.6, high: 104.9, low: 103.2, close: 104.6, volume: 18 },
  { label: "2026-04-12T11:04:00.000Z", open: 104.6, high: 105.05, low: 104.1, close: 104.7, volume: 16 },
  { label: "2026-04-12T11:05:00.000Z", open: 104.7, high: 105.1, low: 104.3, close: 104.8, volume: 17 },
  { label: "2026-04-12T11:06:00.000Z", open: 104.8, high: 105.55, low: 104.6, close: 104.65, volume: 24 },
  { label: "2026-04-12T11:07:00.000Z", open: 104.65, high: 105.62, low: 103.95, close: 104.1, volume: 26 },
];

const fakeStructure = detectStructure(fakeBreakoutCandles);
const fakeRegime = buildRegimeSnapshot(fakeBreakoutCandles);
const fakeLiquidity = detectLiquidity(fakeBreakoutCandles, fakeStructure);
const fakeDecision = resolveSmartDecision({
  regime: fakeRegime,
  structure: fakeStructure,
  liquidity: fakeLiquidity,
  predictionDirection: "LONG",
  predictionProbability: 74,
  predictionTrigger: 105.4,
  predictionInvalidation: 103.9,
  lowFlowEdgeBlocked: false,
  routeScorePct: 68,
  domImbalance: 0.18,
  decisionLatencyMs: 240,
});

assert.equal(fakeDecision.state, "FAKE_BREAKOUT_RISK", "equal-high sweep rejection should block a long breakout trigger");

const conflictDecision = resolveSmartDecision({
  regime: {
    ...bullRegime,
    state: "CONFLICT",
    aligned: false,
    alignmentStrength: 0.34,
    bias: "neutral",
    reason: "Higher horizons disagree",
  },
  structure: bullStructure,
  liquidity: bullLiquidity,
  predictionDirection: "LONG",
  predictionProbability: 52,
  predictionTrigger: 105.4,
  predictionInvalidation: 104.0,
  lowFlowEdgeBlocked: false,
  routeScorePct: 63,
  domImbalance: 0.04,
  decisionLatencyMs: 320,
});

assert.equal(conflictDecision.state, "NO_TRADE", "conflicting horizons with weak alignment should force no trade");

console.log("PASS regime-decision regression: bull regime, fake breakout risk, and conflict gating resolve to a unique decision state");