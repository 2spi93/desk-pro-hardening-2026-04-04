import assert from "node:assert/strict";

import { buildFeedbackSummary } from "../../app/terminal/feedbackEngine";

const brokenSummary = buildFeedbackSummary({
  executionPnlPayload: {
    summary: {
      trade_count: 7,
      net_pnl_usd: -12.4,
      avg_pnl_usd: -1.77,
      win_rate_pct: 28.5,
      avg_latency_ms: 168,
      avg_slippage_bps: 4.6,
      high_confidence_loss_count: 2,
      no_trade_dominance_count: 0,
    },
    trades: [
      {
        decision_id: "dec-1",
        confidence: 0.82,
        net_result_usd: -4.4,
        latency_ms: 170,
        slippage_real_bps: 5.1,
        status: "filled",
        no_trade_state: "eligible",
        dominant_reasons: ["breakout"],
      },
      {
        decision_id: "dec-2",
        confidence: 0.78,
        net_result_usd: -3.1,
        latency_ms: 154,
        slippage_real_bps: 4.8,
        status: "filled",
        no_trade_state: "eligible",
        dominant_reasons: ["trend"],
      },
      {
        decision_id: "dec-3",
        confidence: 0.58,
        net_result_usd: 1.1,
        latency_ms: 132,
        slippage_real_bps: 3.2,
        status: "filled",
        no_trade_dominance: true,
        no_trade_state: "wait",
        no_trade_reasons: ["micro chop"],
      },
    ],
    by_regime: [
      { regime: "TREND", trade_count: 3, net_pnl_usd: 8.4 },
      { regime: "CHOP", trade_count: 4, net_pnl_usd: -20.8 },
    ],
    bad_model_flags: [
      { decision_id: "dec-2", net_result_usd: -3.1 },
    ],
  },
  liveOpsPayload: {
    watchdog_state: {
      status: "WARNING",
      drift: 0.31,
      health_score: 42,
    },
    risk_snapshot: {
      dd_pct: 3.4,
    },
    memory_gap: {
      reality_gap_score: 0.34,
      drift_detected: true,
    },
    governance: {
      mode: "LIVE",
    },
  },
  executionAiV6Payload: {
    snapshot: {
      reward_ema: 0.44,
      guardrails: {
        learning_frozen: false,
      },
    },
  },
  journalEntries: [
    { action: "override-visible-on", createdAtIso: "2026-04-12T08:15:00.000Z" },
    { action: "auto-reduce", createdAtIso: "2026-04-12T08:30:00.000Z" },
  ],
  nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
});

assert.equal(brokenSummary.modelHealth, "BROKEN", "drawdown and feedback errors should force broken model health");
assert.equal(brokenSummary.driftState, "LOCK", "elevated drift and drawdown should lock the drift state");
assert.equal(brokenSummary.forceNoTrade, true, "broken desk should force no-trade");
assert.equal(brokenSummary.learningDisabled, true, "broken desk should disable learning");
assert.equal(brokenSummary.shield.multiRegimeValidation, "REJECT", "single profitable regime should reject the update");
assert.equal(brokenSummary.calibrationActions.length > 0, true, "broken desk should propose bounded calibration actions");
assert.equal(
  brokenSummary.calibrationActions.reduce((sum, action) => sum + action.magnitudePct, 0) <= brokenSummary.maxAdjustmentPerDayPct,
  true,
  "daily calibration budget must stay capped at 5%",
);

const healthySummary = buildFeedbackSummary({
  executionPnlPayload: {
    summary: {
      trade_count: 6,
      net_pnl_usd: 9.2,
      avg_pnl_usd: 1.53,
      win_rate_pct: 66.7,
      avg_latency_ms: 82,
      avg_slippage_bps: 1.6,
      high_confidence_loss_count: 0,
      no_trade_dominance_count: 2,
    },
    trades: [
      {
        decision_id: "good-1",
        confidence: 0.66,
        net_result_usd: 2.4,
        latency_ms: 75,
        slippage_real_bps: 1.2,
        status: "filled",
        no_trade_state: "eligible",
        dominant_reasons: ["trend continuation"],
      },
      {
        decision_id: "good-2",
        confidence: 0.61,
        net_result_usd: 1.8,
        latency_ms: 88,
        slippage_real_bps: 1.9,
        status: "filled",
        no_trade_state: "eligible",
        dominant_reasons: ["range response"],
      },
      {
        decision_id: "good-3",
        confidence: 0.54,
        net_result_usd: -0.2,
        latency_ms: 94,
        slippage_real_bps: 1.4,
        status: "filled",
        no_trade_dominance: true,
        no_trade_state: "wait",
        no_trade_reasons: ["no follow through"],
      },
    ],
    by_regime: [
      { regime: "TREND", trade_count: 3, net_pnl_usd: 5.4 },
      { regime: "RANGE", trade_count: 3, net_pnl_usd: 3.8 },
    ],
    bad_model_flags: [],
  },
  liveOpsPayload: {
    watchdog_state: {
      status: "OK",
      drift: 0.06,
      health_score: 88,
    },
    risk_snapshot: {
      dd_pct: 0.7,
    },
    memory_gap: {
      reality_gap_score: 0.08,
      drift_detected: false,
    },
    governance: {
      mode: "LIVE",
    },
  },
  executionAiV6Payload: {
    snapshot: {
      reward_ema: 0.18,
      guardrails: {
        learning_frozen: false,
      },
    },
  },
  journalEntries: [],
  nowMs: Date.parse("2026-04-12T12:00:00.000Z"),
});

assert.equal(healthySummary.modelHealth, "HEALTHY", "clean live samples should keep the model healthy");
assert.equal(healthySummary.driftState, "CALM", "low drift should keep the desk calm");
assert.equal(healthySummary.shield.multiRegimeValidation, "PASS", "diversified profitable regimes should pass validation");
assert.equal(healthySummary.forceNoTrade, false, "healthy desk should not hard force no-trade");
assert.equal(healthySummary.learningDisabled, false, "healthy desk should keep learning enabled");
assert.equal(healthySummary.reward.scorePct > 60, true, "healthy desk should expose a strong reward score");
assert.equal(healthySummary.calibrationActions.length, 0, "healthy desk should avoid unnecessary calibration changes");

console.log("PASS feedback-engine regression: broken desks lock learning and healthy desks stay adaptive under budgeted calibration");