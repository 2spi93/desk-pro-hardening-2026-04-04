import { NextResponse } from "next/server";

import { requireControlPlaneSession } from "../../../../lib/apiAuth";
import { cpFetchJsonSafe, getControlPlaneNetworkMetricsSnapshot } from "../../../../lib/controlPlane";
import { computeExecutionDomination } from "../../../../lib/liveOps/executionDominationEngine";
import { classifyMarketState } from "../../../../lib/liveOps/marketStateEngine";
import { detectSmartMoney } from "../../../../lib/liveOps/smartMoneyDetector";
import { detectSpoofing } from "../../../../lib/liveOps/spoofDetectionEngine";
import { evaluateVenueArbitrage, type VenueQuoteSnapshot } from "../../../../lib/liveOps/venueArbitrageEngine";
import { getMetricsSnapshot } from "../../../../lib/shadowMode";

type JsonMap = Record<string, unknown>;

function asRecord(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonMap) : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mapSystemMode(mode: string, killSwitchActive: boolean): "SAFE" | "LIVE" | "LOCKED" {
  if (killSwitchActive) {
    return "LOCKED";
  }
  if (mode === "managed_live") {
    return "LIVE";
  }
  return "SAFE";
}

function deriveExposureBySymbol(telemetryRows: JsonMap[]): Array<{ symbol: string; notionalUsd: number }> {
  const exposures = new Map<string, number>();
  for (const row of telemetryRows) {
    const symbol = String(row.symbol || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    exposures.set(symbol, (exposures.get(symbol) || 0) + Math.abs(toNumber(row.lots, 0)));
  }
  return [...exposures.entries()]
    .map(([symbol, notionalUsd]) => ({ symbol, notionalUsd: Number(notionalUsd.toFixed(6)) }))
    .sort((left, right) => right.notionalUsd - left.notionalUsd)
    .slice(0, 6);
}

function buildRiskTimeline(outcomes: JsonMap[], exposures: Array<{ symbol: string; notionalUsd: number }>): JsonMap[] {
  const rows = [...outcomes].reverse();
  const dominantExposure = exposures[0]?.notionalUsd || 0;
  let cumulativePnLUsd = 0;
  let peakPnLUsd = 0;
  return rows.slice(-12).map((row) => {
    cumulativePnLUsd += toNumber(row.net_result_usd, 0);
    peakPnLUsd = Math.max(peakPnLUsd, cumulativePnLUsd);
    const drawdownUsd = peakPnLUsd - cumulativePnLUsd;
    const drawdownPct = dominantExposure > 0 ? (drawdownUsd / dominantExposure) * 100 : 0;
    return {
      at: String(row.updated_at || row.created_at || ""),
      dd_usd: Number(drawdownUsd.toFixed(4)),
      dd_pct: Number(drawdownPct.toFixed(4)),
      exposure_symbol: String(row.symbol || exposures[0]?.symbol || "UNKNOWN"),
      exposure_proxy: Number(Math.abs(toNumber(row.net_result_usd, 0)).toFixed(4)),
      decision: String(row.status || row.source || "UNKNOWN"),
    };
  });
}

function buildAuditTrail(auditRows: JsonMap[], telemetryRows: JsonMap[], realityGapRows: JsonMap[]): JsonMap[] {
  const telemetryByDecision = new Map<string, JsonMap>();
  for (const row of telemetryRows) {
    telemetryByDecision.set(String(row.decision_id || ""), row);
  }
  const gapByDecision = new Map<string, JsonMap>();
  for (const row of realityGapRows) {
    gapByDecision.set(String(row.decision_id || ""), row);
  }

  return auditRows
    .filter((row) => {
      const category = String(row.category || "");
      return category === "execution_telemetry_recorded" || category === "go_live_hardening_decision" || category === "live_order_cancelled";
    })
    .slice(0, 16)
    .map((row) => {
      const payload = asRecord(row.payload);
      const decisionId = String(payload.decision_id || "");
      const telemetry = telemetryByDecision.get(decisionId) || {};
      const gap = gapByDecision.get(decisionId) || {};
      const memoryGate = asRecord(asRecord(telemetry).pre_trade_memory_gate);
      return {
        at: String(row.timestamp || row.created_at || ""),
        decision_id: decisionId,
        decision: String(payload.route || payload.status || row.category || "UNKNOWN"),
        memory: memoryGate.block_execution ? "BLOCKED" : memoryGate.status ? String(memoryGate.status).toUpperCase() : "OK",
        risk: asArray<string>(asRecord(gap).failure_reasons).length > 0 ? "WATCH" : "OK",
        execution: String(payload.reason || payload.route || "AGGRESSIVE"),
        result: String(payload.status || row.category || "UNKNOWN").toUpperCase(),
        pnl: Number(toNumber(asRecord(gap).gap_impact_bps, 0).toFixed(4)),
        route: String(payload.route || asRecord(telemetry).route_chosen || "n/a"),
        slippage_bps: Number(toNumber(payload.realized_slippage_bps || asRecord(telemetry).realized_slippage_bps, 0).toFixed(4)),
        latency_ms: Number(toNumber(payload.latency_e2e_ms || asRecord(telemetry).latency_e2e_ms, 0).toFixed(0)),
      };
    });
}

function computeDrawdownUsd(outcomes: JsonMap[]): number {
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of [...outcomes].reverse()) {
    cumulative += toNumber(row.net_result_usd, 0);
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return maxDrawdown;
}

export async function GET(): Promise<NextResponse> {
  const authError = await requireControlPlaneSession();
  if (authError) {
    return authError;
  }
  const shadowSnapshot = getMetricsSnapshot();
  const networkSnapshot = getControlPlaneNetworkMetricsSnapshot();
  const [killSwitchResult, systemConfigResult, telemetryResult, realityGapResult, auditResult, outcomesResult, dashboardResult] = await Promise.all([
    cpFetchJsonSafe("/v1/system/kill-switch"),
    cpFetchJsonSafe("/v1/system/config"),
    cpFetchJsonSafe("/v1/execution/telemetry/recent?limit=40"),
    cpFetchJsonSafe("/v1/execution/reality-gap/recent?limit=40"),
    cpFetchJsonSafe("/v1/audit?limit=120"),
    cpFetchJsonSafe("/v1/outcomes/recent?limit=40"),
    cpFetchJsonSafe("/v1/dashboard/overview"),
  ]);

  const killSwitchPayload = asRecord(killSwitchResult.payload);
  const killSwitchState = asRecord(killSwitchPayload.state);
  const hardening = asRecord(killSwitchPayload.go_live_hardening);
  const watchdogPolicy = asRecord(hardening.watchdog);
  const telemetryRows = asArray<JsonMap>(telemetryResult.payload);
  const realityGapRows = asArray<JsonMap>(asRecord(realityGapResult.payload).rows);
  const auditRows = asArray<JsonMap>(auditResult.payload);
  const outcomesRows = asArray<JsonMap>(outcomesResult.payload);
  const systemConfig = asRecord(systemConfigResult.payload);
  const dashboard = asRecord(dashboardResult.payload);

  const avgLatencyMs = average(telemetryRows.map((row) => toNumber(row.latency_e2e_ms, 0)), 0);
  const avgSlippageBps = average(telemetryRows.map((row) => toNumber(row.realized_slippage_bps, 0)), 0);
  const avgDriftScore = average(
    realityGapRows.map((row) => (
      Math.abs(toNumber(row.gap_slippage_bps, 0)) * 0.04
      + Math.abs(toNumber(row.gap_fill_probability, 0)) * 1.6
      + Math.abs(toNumber(row.gap_latency_ms, 0)) / 400
    )),
    0,
  );
  const maxRealizedSlippageBps = Math.max(1, toNumber(watchdogPolicy.max_realized_slippage_bps, 15));
  const blockRate = telemetryRows.length > 0
    ? telemetryRows.filter((row) => toNumber(row.realized_slippage_bps, 0) > maxRealizedSlippageBps).length / telemetryRows.length
    : 0;
  const errorRate = clamp(Math.max(networkSnapshot.degraded_usage_ratio, networkSnapshot.timeout_rate, blockRate), 0, 1);
  const killSwitchActive = Boolean(killSwitchState.active);
  const anomalyScore = clamp(
    (avgLatencyMs / Math.max(1, toNumber(watchdogPolicy.max_latency_e2e_ms, 1500))) * 0.28
      + avgDriftScore * 0.32
      + errorRate * 0.24
      + (killSwitchActive ? 0.4 : 0),
    0,
    1,
  );
  const watchdogStatus = killSwitchActive || anomalyScore >= 0.8 ? "HALT" : anomalyScore >= 0.4 ? "WARNING" : "OK";
  const healthScore = clamp((1 - anomalyScore) * 100, 0, 100);

  const exposures = deriveExposureBySymbol(telemetryRows);
  const dailyUsedUsd = toNumber(dashboard.net_exposure_usd, 0);
  const drawdownUsd = computeDrawdownUsd(outcomesRows);
  const dominantExposure = exposures[0]?.notionalUsd || 0;
  const drawdownPct = dominantExposure > 0 ? (drawdownUsd / dominantExposure) * 100 : 0;
  const latestGap = realityGapRows[0] || {};
  const lastTelemetry = telemetryRows[0] || {};
  const preTradeMemoryGate = asRecord(asRecord(lastTelemetry).pre_trade_memory_gate);
  const memoryDecision = preTradeMemoryGate.block_execution
    ? "BLOCKED"
    : preTradeMemoryGate.status
      ? String(preTradeMemoryGate.status).toUpperCase()
      : "OK";
  const dominantCause = String(asRecord(latestGap).failure_source || (asArray<string>(asRecord(latestGap).failure_reasons)[0] || "none")).trim() || "none";

  const quotes: VenueQuoteSnapshot[] = telemetryRows.slice(0, 4).map((row, index) => ({
    venue: String(row.route_chosen || row.route_backup || `venue-${index + 1}`).trim().toLowerCase() || `venue-${index + 1}`,
    bid: 100 + index * 0.15 + Math.max(0, 0.1 - toNumber(row.realized_slippage_bps, 0) * 0.001),
    ask: 100 + index * 0.15 + 0.2 + Math.max(0, toNumber(row.realized_slippage_bps, 0) * 0.001),
    latencyMs: toNumber(row.latency_e2e_ms, 0),
    slippageBps: toNumber(row.realized_slippage_bps, 0),
    feeBps: 1.5,
    availableDepthUsd: Math.max(0, toNumber(row.available_depth_usd, 0)),
  }));
  const arbitrage = evaluateVenueArbitrage(quotes);
  const smartMoney = detectSmartMoney({
    absorption: clamp(1 - Math.abs(toNumber(asRecord(latestGap).gap_fill_probability, 0)), 0, 1),
    deltaDivergence: clamp(Math.abs(toNumber(asRecord(latestGap).gap_impact_bps, 0)) / 12, 0, 1),
    priceStability: clamp(1 - Math.abs(toNumber(asRecord(latestGap).gap_slippage_bps, 0)) / 12, 0, 1),
    liquidityHold: clamp(sum(exposures.map((item) => item.notionalUsd)) / 100, 0, 1),
    volumeImpulse: clamp(Math.abs(dailyUsedUsd) / 100, 0, 1),
  });
  const spoof = detectSpoofing({
    largeOrdersRemovedRatio: clamp(networkSnapshot.retry_recovered_ratio * 2.4, 0, 1),
    liquidityFakeScore: clamp(networkSnapshot.degraded_usage_ratio * 2.8, 0, 1),
    reversalSpeed: clamp(avgDriftScore, 0, 1),
    tradeFollowThrough: clamp(1 - blockRate, 0, 1),
    cancelVelocity: clamp(networkSnapshot.dns_transient_rate * 3, 0, 1),
  });
  const marketState = classifyMarketState({
    trendStrength: clamp(arbitrage.netEdgeBps / 12, 0, 1),
    volatility: clamp(avgDriftScore, 0, 1),
    liquidityScore: clamp(sum(exposures.map((item) => item.notionalUsd)) / 120, 0, 1),
    spoofState: spoof.state,
    smartMoneyState: smartMoney.state,
    trapProbability: clamp(spoof.score * 0.6 + blockRate * 0.4, 0, 1),
  });
  const domination = computeExecutionDomination({
    latencyEdgeMs: Math.max(0, 25 - avgLatencyMs),
    liquidityAdvantage: clamp(sum(exposures.map((item) => item.notionalUsd)) / 120, 0, 1),
    executionQuality: clamp(1 - avgDriftScore, 0, 1),
    fillProbability: clamp(1 - blockRate, 0, 1),
    slippageBps: avgSlippageBps,
    riskScore: clamp(drawdownPct / 10, 0, 1),
  });

  const alerts = [
    avgDriftScore > 0.2 ? { severity: "warn", code: "execution_drift", message: "Execution drift detected", detail: `drift=${avgDriftScore.toFixed(3)}` } : null,
    avgSlippageBps > 10 ? { severity: "warn", code: "slippage_spike", message: "Slippage spike", detail: `${avgSlippageBps.toFixed(2)} bps` } : null,
    killSwitchActive ? { severity: "critical", code: "kill_switch_active", message: "System critical", detail: String(killSwitchState.reason || "kill switch active") } : null,
    anomalyScore > 0.8 ? { severity: "critical", code: "preemptive_shutdown", message: "Preemptive shutdown ready", detail: `anomaly_score=${anomalyScore.toFixed(3)}` } : null,
  ].filter(Boolean);

  return NextResponse.json({
    status: "ok",
    generated_at: new Date().toISOString(),
    watchdog_state: {
      latency: Number(avgLatencyMs.toFixed(2)),
      drift: Number(avgDriftScore.toFixed(4)),
      error_rate: Number(errorRate.toFixed(4)),
      anomaly_score: Number(anomalyScore.toFixed(4)),
      status: watchdogStatus,
      triggers: alerts.map((item) => asRecord(item).code),
      health_score: Number(healthScore.toFixed(2)),
    },
    risk_snapshot: {
      dd_pct: Number(drawdownPct.toFixed(4)),
      dd_usd: Number(drawdownUsd.toFixed(4)),
      exposure_by_symbol: exposures,
      daily_used_usd: Number(dailyUsedUsd.toFixed(4)),
      avg_slippage_bps: Number(avgSlippageBps.toFixed(4)),
      notional_proxy_usd: Number(sum(exposures.map((item) => item.notionalUsd)).toFixed(4)),
    },
    risk_timeline: buildRiskTimeline(outcomesRows, exposures),
    audit_trail: buildAuditTrail(auditRows, telemetryRows, realityGapRows),
    memory_gap: {
      memory_decision: memoryDecision,
      reality_gap_score: Number(avgDriftScore.toFixed(4)),
      drift_detected: avgDriftScore > 0.2,
      dominant_cause: dominantCause,
      last_failure_reasons: asArray<string>(asRecord(latestGap).failure_reasons),
    },
    governance: {
      mode: mapSystemMode(String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"), killSwitchActive),
      backend_mode: String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"),
      operator_override: !killSwitchActive,
      high_risk_trades_blocked: killSwitchActive || mapSystemMode(String(systemConfig.system_mode || dashboard.system_mode || "guarded_auto"), killSwitchActive) !== "LIVE",
      paper_only: Boolean(dashboard.paper_only),
    },
    recovery: {
      active: killSwitchActive || watchdogStatus === "HALT",
      mode: killSwitchActive ? "RECOVERY_LOCKDOWN" : watchdogStatus === "WARNING" ? "SAFE_RECOVERY" : "NOMINAL",
      reduced_risk: killSwitchActive || avgDriftScore > 0.2,
      blocked_trades: killSwitchActive || blockRate > 0.35,
    },
    alerts,
    warfare_core: {
      arbitrage,
      smart_money: smartMoney,
      spoof,
      market_state: marketState,
      domination,
    },
    raw: {
      kill_switch: killSwitchPayload,
      network: networkSnapshot,
      shadow: {
        fallback_rate: shadowSnapshot.fallback_rate,
        metrics: shadowSnapshot.metrics,
      },
    },
  }, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}