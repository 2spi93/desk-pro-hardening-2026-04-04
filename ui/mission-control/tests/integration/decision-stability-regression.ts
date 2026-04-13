import assert from "node:assert/strict";

import { applyDecisionStability, createDecisionStabilityEngine } from "../../app/terminal/decisionStabilityEngine";
import { resolveSmartDecision } from "../../app/terminal/decisionEngine";
import { detectLiquidity } from "../../app/terminal/liquidityEngine";
import { buildRegimeSnapshot } from "../../app/terminal/regimeEngine";
import { detectStructure } from "../../app/terminal/structureEngine";

const trendCandles = [
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

const structure = detectStructure(trendCandles);
const regime = buildRegimeSnapshot(trendCandles);
const liquidity = detectLiquidity(trendCandles, structure);
const entryDecision = resolveSmartDecision({
  regime,
  structure,
  liquidity,
  predictionDirection: "LONG",
  predictionProbability: 78,
  predictionTrigger: 105.6,
  predictionInvalidation: 104.1,
  lowFlowEdgeBlocked: false,
  routeScorePct: 72,
  domImbalance: 0.21,
  decisionLatencyMs: 180,
});

assert.equal(entryDecision.state, "ENTRY_VALID", "baseline aligned trend should still validate entry before stability gating");

const persistenceEngine = createDecisionStabilityEngine({ stableThresholdMs: 800, maxFlipsWindowMs: 2_000 });
const initialStability = persistenceEngine.update("ENTRY_VALID", 0);
assert.equal(initialStability.isStable, false, "fresh state should start unstable");
assert.equal(initialStability.confidenceBand, "LOW", "fresh state should expose low confidence band");

const settledStability = persistenceEngine.update("ENTRY_VALID", 900);
assert.equal(settledStability.isStable, true, "persistent state should become stable after threshold");
assert.equal(settledStability.confidenceBand, "HIGH", "persistent state should graduate to high confidence band");

const unstableEngine = createDecisionStabilityEngine({ stableThresholdMs: 800, maxFlipsWindowMs: 2_000 });
const unstableDecision = applyDecisionStability(entryDecision, unstableEngine.update("ENTRY_VALID", 0));
assert.equal(unstableDecision.state, "WAIT_CONFIRMATION", "entry-valid should degrade to wait-confirmation until persistence is earned");
assert.equal(unstableDecision.qualityGate, "warn", "unstable entry should soften the quality gate");

const churnEngine = createDecisionStabilityEngine({ stableThresholdMs: 800, maxFlipsWindowMs: 2_000 });
churnEngine.update("ENTRY_VALID", 0);
churnEngine.update("WAIT_CONFIRMATION", 200);
churnEngine.update("ENTRY_VALID", 400);
churnEngine.update("WAIT_CONFIRMATION", 600);
const churnStability = churnEngine.update("ENTRY_VALID", 800);
const churnDecision = applyDecisionStability(entryDecision, churnStability);

assert.equal(churnStability.flipCount >= 4, true, "flip cluster should be recorded inside the stability window");
assert.equal(churnDecision.state, "NO_TRADE", "flip cluster should hard degrade the decision to no-trade");
assert.equal(churnDecision.qualityGate, "fail", "flip cluster should fail the quality gate");

console.log("PASS decision-stability regression: persistence upgrades confidence, unstable entries wait, and flip clusters force no-trade");