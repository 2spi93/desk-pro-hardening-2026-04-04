import { defaultExecutionRlPolicy, updateExecutionRlPolicy, type ExecutionRlPolicy } from "./executionRL";
import { predictLatencyShift, type LatencyPrediction } from "./latencyPredictor";
import { estimateQueuePosition } from "./queueEstimator";

type JsonMap = Record<string, unknown>;

export type V7RouteMode = "bestSingleVenue" | "dualVenueExecution";

export type ArbOpportunity = {
  buyVenue: string;
  sellVenue: string;
  spreadBps: number;
  confidence: number;
  latencyCostBps: number;
  expectedSlippageBps: number;
  expectedNetEdgeBps: number;
  targetNotionalUsd: number;
  averageQueuePosition: number;
  shouldReprice: boolean;
  latencyPrediction: LatencyPrediction | null;
  executionPolicy: ExecutionRlPolicy;
  splitPlan: ArbExecutionPlan | null;
  routeMode: V7RouteMode;
};

export type ArbPlanLeg = {
  venue: string;
  price: number;
  size: number;
  notionalUsd: number;
  latencyMs: number;
  feeBps: number;
  fillProbability: number;
  routeScore: number;
  levelIndex: number;
};

export type ArbPlanSlice = {
  id: string;
  notionalUsd: number;
  quantity: number;
  grossSpread: number;
  grossSpreadBps: number;
  netSpreadBps: number;
  latencyGapMs: number;
  buy: ArbPlanLeg;
  sell: ArbPlanLeg;
};

export type ArbExecutionPlan = {
  slices: ArbPlanSlice[];
  totalNotionalUsd: number;
  weightedBuyPrice: number;
  weightedSellPrice: number;
  weightedGrossSpreadBps: number;
  weightedNetSpreadBps: number;
  weightedLatencyGapMs: number;
};

export type V7Candidate = {
  venue: string;
  score: number;
  depthScore: number;
  latencyScore: number;
  fillProbability: number;
  feeScore: number;
  availableDepthUsd: number;
  freshnessMs: number;
  latencyMs: number;
  spreadBps: number;
};

export type V7Decision = {
  shouldExecute: boolean;
  routeMode: V7RouteMode;
  expectedNetEdgeBps: number;
  expectedSlippageBps: number;
  latencyCostBps: number;
  reasons: string[];
  opportunity: ArbOpportunity | null;
  bestCandidate: V7Candidate | null;
  backupCandidate: V7Candidate | null;
  frameLocked: boolean;
  renderThrottleActive: boolean;
};

export type V7ExecutionOrder = {
  symbol: string;
  side: "buy" | "sell";
  notionalUsd: number;
  venue?: string;
  maxSpreadBps: number;
  rationale: string;
  metadata?: JsonMap;
  orderIntent?: JsonMap;
};

export type V7FillFeedback = {
  venue: string;
  expectedPrice?: number;
  actualPrice?: number;
  latencyMs?: number;
  realizedSlippageBps?: number;
};

type VenueFeedbackStats = {
  samples: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
};

type ExecutionFnResult = {
  ok: boolean;
  venue: string;
  payload?: JsonMap;
  error?: string;
};

type ExecuteArbParams = {
  opportunity: ArbOpportunity;
  buyOrder: V7ExecutionOrder;
  sellOrder: V7ExecutionOrder;
  sendOrder: (order: V7ExecutionOrder) => Promise<ExecutionFnResult>;
  hedgeImmediately?: (failedLeg: "buy" | "sell", succeeded: ExecutionFnResult) => Promise<void>;
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return 0;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function normalizeVenue(value: unknown): string {
  return String(value || "").trim();
}

function scoreLatency(latencyMs: number): number {
  if (!(latencyMs > 0)) {
    return 0.35;
  }
  return clamp(1 - latencyMs / 250, 0.05, 1);
}

function scoreDepth(depthUsd: number): number {
  if (!(depthUsd > 0)) {
    return 0.05;
  }
  return clamp(Math.log10(Math.max(10, depthUsd)) / 5.5, 0.05, 1);
}

function scoreFees(spreadBps: number, feePenaltyBps: number): number {
  const totalCost = Math.max(0, spreadBps + feePenaltyBps);
  return clamp(1 - totalCost / 40, 0.05, 1);
}

export class ExecutionEngineV7 {
  private venueFeedback = new Map<string, VenueFeedbackStats>();
  private pairLatencyHistory = new Map<string, number[]>();
  private policyByPair = new Map<string, ExecutionRlPolicy>();

  updateFeedback(feedback: V7FillFeedback): void {
    const venue = normalizeVenue(feedback.venue);
    if (!venue) {
      return;
    }
    const current = this.venueFeedback.get(venue) || {
      samples: 0,
      avgLatencyMs: 0,
      avgSlippageBps: 0,
    };
    const nextSamples = current.samples + 1;
    const latencyMs = toNumber(feedback.latencyMs, current.avgLatencyMs || 0);
    const slippageBps = toNumber(feedback.realizedSlippageBps, current.avgSlippageBps || 0);
    this.venueFeedback.set(venue, {
      samples: nextSamples,
      avgLatencyMs: current.avgLatencyMs * 0.75 + latencyMs * 0.25,
      avgSlippageBps: current.avgSlippageBps * 0.75 + slippageBps * 0.25,
    });
  }

  buildDecision(input: {
    arbitrage: JsonMap | null;
    routingCandidates: JsonMap[];
    bestRoute: JsonMap | null;
    backupRoute: JsonMap | null;
    marketMicro: JsonMap | null;
    avgExecutionLatencyMs: number;
    renderFrameMs: number;
    renderFps: number;
    notionalUsd: number;
    feePenaltyBps?: number;
  }): V7Decision {
    const feePenaltyBps = toNumber(input.feePenaltyBps, 6);
    const candidates = this.buildCandidates(input.routingCandidates, feePenaltyBps);
    const bestCandidate = candidates[0] || this.toCandidate(input.bestRoute, feePenaltyBps);
    const backupCandidate = candidates[1] || this.toCandidate(input.backupRoute, feePenaltyBps);
    const opportunity = this.buildOpportunity({
      arbitrage: input.arbitrage,
      bestCandidate,
      backupCandidate,
      marketMicro: input.marketMicro,
      avgExecutionLatencyMs: input.avgExecutionLatencyMs,
      notionalUsd: input.notionalUsd,
      feePenaltyBps,
    });

    const reasons: string[] = [];
    const frameLocked = input.renderFrameMs <= 16.7 && input.renderFps >= 55;
    const renderThrottleActive = input.renderFrameMs > 16.7 || input.renderFps < 55;
    if (!frameLocked) {
      reasons.push("render_over_budget");
    }
    if (!bestCandidate) {
      reasons.push("no_route_candidate");
    }

    if (opportunity) {
      if (opportunity.confidence <= 0.6) {
        reasons.push("confidence_below_threshold");
      }
      if (opportunity.expectedNetEdgeBps <= 0) {
        reasons.push("negative_net_edge");
      }
      if (opportunity.expectedNetEdgeBps <= opportunity.expectedSlippageBps) {
        reasons.push("slippage_exceeds_edge");
      }
      if (opportunity.averageQueuePosition >= 0.82 || opportunity.shouldReprice) {
        reasons.push("queue_position_degraded");
      }
    }

    const shouldExecute = Boolean(
      opportunity
      && frameLocked
      && opportunity.confidence > 0.6
      && opportunity.expectedNetEdgeBps > 0
      && opportunity.expectedNetEdgeBps > opportunity.expectedSlippageBps
      && opportunity.averageQueuePosition < 0.82
    );

    return {
      shouldExecute,
      routeMode: opportunity?.routeMode || "bestSingleVenue",
      expectedNetEdgeBps: toNumber(opportunity?.expectedNetEdgeBps, 0),
      expectedSlippageBps: toNumber(opportunity?.expectedSlippageBps, 0),
      latencyCostBps: toNumber(opportunity?.latencyCostBps, 0),
      reasons,
      opportunity,
      bestCandidate,
      backupCandidate,
      frameLocked,
      renderThrottleActive,
    };
  }

  async executeArb(params: ExecuteArbParams): Promise<{
    ok: boolean;
    buy: ExecutionFnResult;
    sell: ExecutionFnResult;
    hedged: boolean;
    executedNotionalUsd: number;
    sliceCount: number;
    latencyPrediction: LatencyPrediction | null;
    executionPolicy: ExecutionRlPolicy;
    plan: ArbExecutionPlan | null;
  }> {
    const requestedNotionalUsd = Math.max(0, Math.min(params.buyOrder.notionalUsd, params.sellOrder.notionalUsd));
    const executionPolicy = params.opportunity.executionPolicy || defaultExecutionRlPolicy();
    const slices = this.materializePlanSlices(params.opportunity, requestedNotionalUsd);
    const buyChildren: ExecutionFnResult[] = [];
    const sellChildren: ExecutionFnResult[] = [];
    let hedged = false;
    for (const [index, slice] of slices.entries()) {
      if (index > 0 && executionPolicy.delayMs > 0) {
        await this.wait(executionPolicy.delayMs);
      }
      const sliceMetadata = {
        arb_plan_slice_id: slice.id,
        arb_plan_slice_index: index + 1,
        arb_plan_slice_count: slices.length,
        arb_plan_slice_notional_usd: Number(slice.notionalUsd.toFixed(2)),
        arb_plan_queue_position: Number(slice.queuePosition.toFixed(3)),
        arb_plan_fill_urgency: slice.fillUrgency,
        arb_plan_latency_gap_ms: Number(slice.latencyGapMs.toFixed(2)),
        arb_latency_prediction: params.opportunity.latencyPrediction,
        arb_execution_policy: executionPolicy,
      } satisfies JsonMap;
      const [buy, sell] = await Promise.all([
        params.sendOrder({
          ...params.buyOrder,
          notionalUsd: slice.notionalUsd,
          venue: slice.buyVenue,
          rationale: `${params.buyOrder.rationale} | slice ${index + 1}/${slices.length}`,
          metadata: { ...(params.buyOrder.metadata || {}), ...sliceMetadata, leg: "buy" },
          orderIntent: { ...(params.buyOrder.orderIntent || {}), leg: "buy", arb_plan_slice: sliceMetadata },
        }),
        params.sendOrder({
          ...params.sellOrder,
          notionalUsd: slice.notionalUsd,
          venue: slice.sellVenue,
          rationale: `${params.sellOrder.rationale} | slice ${index + 1}/${slices.length}`,
          metadata: { ...(params.sellOrder.metadata || {}), ...sliceMetadata, leg: "sell" },
          orderIntent: { ...(params.sellOrder.orderIntent || {}), leg: "sell", arb_plan_slice: sliceMetadata },
        }),
      ]);
      buyChildren.push(buy);
      sellChildren.push(sell);
      if (buy.ok !== sell.ok && params.hedgeImmediately) {
        const succeeded = buy.ok ? buy : sell;
        const failedLeg = buy.ok ? "sell" : "buy";
        await params.hedgeImmediately(failedLeg, succeeded);
        hedged = true;
      }
    }

    const buy = this.aggregateExecutionResults(buyChildren, params.buyOrder.venue || params.opportunity.buyVenue);
    const sell = this.aggregateExecutionResults(sellChildren, params.sellOrder.venue || params.opportunity.sellVenue);
    const realizedSlippageBps = average([
      toNumber(buy.payload?.realized_slippage_bps, 0),
      toNumber(sell.payload?.realized_slippage_bps, 0),
    ]);
    const realizedLatencyMs = average([
      toNumber(buy.payload?.latency_ms ?? buy.payload?.latency_e2e_ms, 0),
      toNumber(sell.payload?.latency_ms ?? sell.payload?.latency_e2e_ms, 0),
    ]);
    const fillRate = average([
      buyChildren.length > 0 ? buyChildren.filter((entry) => entry.ok).length / buyChildren.length : 0,
      sellChildren.length > 0 ? sellChildren.filter((entry) => entry.ok).length / sellChildren.length : 0,
    ]);
    this.updatePairHistory(params.opportunity.buyVenue, params.opportunity.sellVenue, Math.abs(
      toNumber(buy.payload?.latency_ms ?? buy.payload?.latency_e2e_ms, 0)
      - toNumber(sell.payload?.latency_ms ?? sell.payload?.latency_e2e_ms, 0),
    ));
    this.policyByPair.set(
      this.toPairKey(params.opportunity.buyVenue, params.opportunity.sellVenue),
      updateExecutionRlPolicy(executionPolicy, {
        slippageBps: Math.abs(realizedSlippageBps),
        fillRate,
        latencyMs: realizedLatencyMs,
      }),
    );

    return {
      ok: buy.ok && sell.ok,
      buy,
      sell,
      hedged,
      executedNotionalUsd: Number(slices.reduce((sum, slice) => sum + slice.notionalUsd, 0).toFixed(2)),
      sliceCount: slices.length,
      latencyPrediction: params.opportunity.latencyPrediction,
      executionPolicy: this.policyByPair.get(this.toPairKey(params.opportunity.buyVenue, params.opportunity.sellVenue)) || executionPolicy,
      plan: params.opportunity.splitPlan,
    };
  }

  private buildCandidates(candidates: JsonMap[], feePenaltyBps: number): V7Candidate[] {
    return candidates
      .map((candidate) => this.toCandidate(candidate, feePenaltyBps))
      .filter((candidate): candidate is V7Candidate => Boolean(candidate))
      .sort((left, right) => right.score - left.score);
  }

  private toCandidate(candidate: JsonMap | null | undefined, feePenaltyBps: number): V7Candidate | null {
    if (!candidate) {
      return null;
    }
    const venue = normalizeVenue(candidate.venue);
    if (!venue) {
      return null;
    }
    const availableDepthUsd = toNumber(candidate.available_depth_usd, 0);
    const freshnessMs = toNumber(candidate.freshness_ms, 0);
    const baseLatencyMs = toNumber(candidate.latency_ms ?? candidate.latency, freshnessMs * 0.2 + 20);
    const feedback = this.venueFeedback.get(venue);
    const latencyMs = clamp(
      feedback ? baseLatencyMs * 0.65 + feedback.avgLatencyMs * 0.35 : baseLatencyMs,
      5,
      2_000,
    );
    const spreadBps = toNumber(candidate.spread_bps ?? candidate.spread, 0);
    const fillProbability = clamp(toNumber(candidate.fill_probability, 0), 0, 1);
    const depthScore = scoreDepth(availableDepthUsd);
    const latencyScore = scoreLatency(latencyMs);
    const feeScore = scoreFees(spreadBps, feePenaltyBps);
    const score = depthScore * 0.35 + latencyScore * 0.25 + fillProbability * 0.25 + feeScore * 0.15;
    return {
      venue,
      score,
      depthScore,
      latencyScore,
      fillProbability,
      feeScore,
      availableDepthUsd,
      freshnessMs,
      latencyMs,
      spreadBps,
    };
  }

  private buildOpportunity(input: {
    arbitrage: JsonMap | null;
    bestCandidate: V7Candidate | null;
    backupCandidate: V7Candidate | null;
    marketMicro: JsonMap | null;
    avgExecutionLatencyMs: number;
    notionalUsd: number;
    feePenaltyBps: number;
  }): ArbOpportunity | null {
    const rawSpreadBps = Math.max(
      0,
      toNumber(input.arbitrage?.net_spread, NaN),
      toNumber(input.marketMicro?.arbitrage_net_spread, 0),
    );
    const buyVenue = normalizeVenue(input.arbitrage?.buy || input.marketMicro?.arbitrage_buy_venue || input.backupCandidate?.venue);
    const sellVenue = normalizeVenue(input.arbitrage?.sell || input.marketMicro?.arbitrage_sell_venue || input.bestCandidate?.venue);
    const bestCandidate = input.bestCandidate;
    const backupCandidate = input.backupCandidate;
    const splitPlan = this.toExecutionPlan(input.arbitrage?.execution_plan);
    const pairKey = this.toPairKey(buyVenue, sellVenue);
    const venueLatencyMs = [
      toNumber(bestCandidate?.latencyMs, 0),
      toNumber(backupCandidate?.latencyMs, 0),
      toNumber(input.avgExecutionLatencyMs, 0),
      toNumber(input.marketMicro?.avg_latency_ms, 0),
    ].filter((value) => value > 0);
    const medianLatencyMs = venueLatencyMs.length > 0
      ? venueLatencyMs.sort((left, right) => left - right)[Math.floor(venueLatencyMs.length / 2)]
      : 35;
    const latencyCostBps = clamp(medianLatencyMs / 25, 0.2, 30);
    const volatilityFactor = clamp(
      1 + Math.abs(toNumber(input.marketMicro?.fusion_deviation_bps, 0)) / 12,
      0.8,
      3,
    );
    const latencyFactor = clamp(0.75 + medianLatencyMs / 80, 0.75, 4);
    const spreadBps = rawSpreadBps > 0
      ? rawSpreadBps
      : Math.max(0, toNumber(bestCandidate?.spreadBps, 0) - toNumber(backupCandidate?.spreadBps, 0));
    const executionPolicy = this.policyByPair.get(pairKey) || defaultExecutionRlPolicy();
    const latencyPrediction = buyVenue && sellVenue
      ? predictLatencyShift({
        venueA: { venue: buyVenue, ts: toNumber(bestCandidate?.latencyMs, medianLatencyMs) },
        venueB: { venue: sellVenue, ts: toNumber(backupCandidate?.latencyMs, medianLatencyMs) },
        history: { latencyGap: this.pairLatencyHistory.get(pairKey) || [] },
        thresholdMs: Math.max(12, medianLatencyMs * 0.25),
      })
      : null;
    const queueEstimates = (splitPlan?.slices || []).map((slice) => estimateQueuePosition({
      orderSize: slice.notionalUsd,
      levelSize: Math.max(1, Math.min(slice.buy.notionalUsd, slice.sell.notionalUsd)),
      tradedVolume: Math.max(1, average([
        slice.buy.notionalUsd * slice.buy.fillProbability * 0.35,
        slice.sell.notionalUsd * slice.sell.fillProbability * 0.35,
      ])),
    }));
    const averageQueuePosition = queueEstimates.length > 0
      ? average(queueEstimates.map((estimate) => estimate.queuePosition))
      : 0.35;
    const queuePenaltyBps = clamp(averageQueuePosition * 6, 0, 9);
    const shouldReprice = queueEstimates.some((estimate) => estimate.shouldReprice);
    const baseSpreadBps = Math.max(
      spreadBps,
      toNumber(bestCandidate?.spreadBps, 0),
      toNumber(backupCandidate?.spreadBps, 0),
      0.1,
    );
    const expectedSlippageBps = clamp(
      baseSpreadBps * volatilityFactor * latencyFactor * (0.08 + executionPolicy.aggression * 0.08)
      + queuePenaltyBps,
      0.1,
      50,
    );
    const expectedNetEdgeBps = spreadBps - latencyCostBps - input.feePenaltyBps - queuePenaltyBps * 0.45;
    const confidenceInputs = [
      toNumber(bestCandidate?.fillProbability, 0),
      toNumber(backupCandidate?.fillProbability, 0),
      clamp(1 - expectedSlippageBps / 25, 0, 1),
      clamp(1 - latencyCostBps / 20, 0, 1),
      clamp(1 - averageQueuePosition, 0, 1),
      latencyPrediction ? clamp(0.65 + latencyPrediction.confidence * 0.35, 0, 1) : 0.5,
    ];
    const confidence = confidenceInputs.reduce((sum, value) => sum + value, 0) / confidenceInputs.length;
    const hasDualVenue = Boolean(buyVenue && sellVenue && buyVenue !== sellVenue);
    const routeMode: V7RouteMode = hasDualVenue && spreadBps > 0 ? "dualVenueExecution" : "bestSingleVenue";
    return {
      buyVenue,
      sellVenue,
      spreadBps,
      confidence,
      latencyCostBps,
      expectedSlippageBps,
      expectedNetEdgeBps,
      targetNotionalUsd: Math.max(25, Math.min(input.notionalUsd, splitPlan?.totalNotionalUsd || input.notionalUsd)),
      averageQueuePosition,
      shouldReprice,
      latencyPrediction,
      executionPolicy,
      splitPlan,
      routeMode,
    };
  }

  private toPairKey(buyVenue: string | null | undefined, sellVenue: string | null | undefined): string {
    return `${normalizeVenue(buyVenue)}->${normalizeVenue(sellVenue)}`;
  }

  private updatePairHistory(buyVenue: string | null | undefined, sellVenue: string | null | undefined, latencyGapMs: number): void {
    const pairKey = this.toPairKey(buyVenue, sellVenue);
    const next = [...(this.pairLatencyHistory.get(pairKey) || []), Math.max(0, latencyGapMs)].slice(-24);
    this.pairLatencyHistory.set(pairKey, next);
  }

  private toExecutionPlan(value: unknown): ArbExecutionPlan | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const rawSlices = Array.isArray(raw.slices) ? raw.slices : [];
    const slices = rawSlices.map((entry, index) => {
      const item = (entry && typeof entry === "object") ? entry as Record<string, unknown> : {};
      const buy = (item.buy && typeof item.buy === "object") ? item.buy as Record<string, unknown> : {};
      const sell = (item.sell && typeof item.sell === "object") ? item.sell as Record<string, unknown> : {};
      return {
        id: String(item.id || `slice-${index + 1}`),
        notionalUsd: Math.max(0, toNumber(item.notionalUsd, 0)),
        quantity: Math.max(0, toNumber(item.quantity, 0)),
        grossSpread: toNumber(item.grossSpread, 0),
        grossSpreadBps: toNumber(item.grossSpreadBps, 0),
        netSpreadBps: toNumber(item.netSpreadBps, 0),
        latencyGapMs: Math.max(0, toNumber(item.latencyGapMs, 0)),
        buy: {
          venue: normalizeVenue(buy.venue),
          price: toNumber(buy.price, 0),
          size: toNumber(buy.size, 0),
          notionalUsd: Math.max(0, toNumber(buy.notionalUsd, toNumber(item.notionalUsd, 0))),
          latencyMs: Math.max(0, toNumber(buy.latencyMs, 0)),
          feeBps: Math.max(0, toNumber(buy.feeBps, 0)),
          fillProbability: clamp(toNumber(buy.fillProbability, 0), 0, 1),
          routeScore: Math.max(0, toNumber(buy.routeScore, 0)),
          levelIndex: Math.max(0, Math.round(toNumber(buy.levelIndex, index))),
        },
        sell: {
          venue: normalizeVenue(sell.venue),
          price: toNumber(sell.price, 0),
          size: toNumber(sell.size, 0),
          notionalUsd: Math.max(0, toNumber(sell.notionalUsd, toNumber(item.notionalUsd, 0))),
          latencyMs: Math.max(0, toNumber(sell.latencyMs, 0)),
          feeBps: Math.max(0, toNumber(sell.feeBps, 0)),
          fillProbability: clamp(toNumber(sell.fillProbability, 0), 0, 1),
          routeScore: Math.max(0, toNumber(sell.routeScore, 0)),
          levelIndex: Math.max(0, Math.round(toNumber(sell.levelIndex, index))),
        },
      } satisfies ArbPlanSlice;
    }).filter((slice) => slice.notionalUsd > 0 && slice.buy.venue && slice.sell.venue);
    if (slices.length === 0) {
      return null;
    }
    return {
      slices,
      totalNotionalUsd: Math.max(0, toNumber(raw.totalNotionalUsd, slices.reduce((sum, slice) => sum + slice.notionalUsd, 0))),
      weightedBuyPrice: Math.max(0, toNumber(raw.weightedBuyPrice, average(slices.map((slice) => slice.buy.price)))),
      weightedSellPrice: Math.max(0, toNumber(raw.weightedSellPrice, average(slices.map((slice) => slice.sell.price)))),
      weightedGrossSpreadBps: toNumber(raw.weightedGrossSpreadBps, average(slices.map((slice) => slice.grossSpreadBps))),
      weightedNetSpreadBps: toNumber(raw.weightedNetSpreadBps, average(slices.map((slice) => slice.netSpreadBps))),
      weightedLatencyGapMs: Math.max(0, toNumber(raw.weightedLatencyGapMs, average(slices.map((slice) => slice.latencyGapMs)))),
    };
  }

  private materializePlanSlices(opportunity: ArbOpportunity, requestedNotionalUsd: number): Array<{
    id: string;
    notionalUsd: number;
    buyVenue: string;
    sellVenue: string;
    latencyGapMs: number;
    queuePosition: number;
    fillUrgency: string;
  }> {
    const splitPlan = opportunity.splitPlan;
    if (!splitPlan || splitPlan.slices.length === 0) {
      return [{
        id: "slice-1",
        notionalUsd: requestedNotionalUsd,
        buyVenue: opportunity.buyVenue,
        sellVenue: opportunity.sellVenue,
        latencyGapMs: toNumber(opportunity.latencyPrediction?.expectedLag, 0),
        queuePosition: opportunity.averageQueuePosition,
        fillUrgency: opportunity.shouldReprice ? "blocked" : "working",
      }];
    }

    let remaining = Math.max(0, Math.min(requestedNotionalUsd, splitPlan.totalNotionalUsd || requestedNotionalUsd));
    const slices: Array<{
      id: string;
      notionalUsd: number;
      buyVenue: string;
      sellVenue: string;
      latencyGapMs: number;
      queuePosition: number;
      fillUrgency: string;
    }> = [];
    for (const slice of splitPlan.slices) {
      if (!(remaining > 0)) {
        break;
      }
      const notionalUsd = Math.min(remaining, slice.notionalUsd);
      const queueEstimate = estimateQueuePosition({
        orderSize: notionalUsd,
        levelSize: Math.max(1, Math.min(slice.buy.notionalUsd, slice.sell.notionalUsd)),
        tradedVolume: Math.max(1, average([
          slice.buy.notionalUsd * slice.buy.fillProbability * 0.35,
          slice.sell.notionalUsd * slice.sell.fillProbability * 0.35,
        ])),
      });
      slices.push({
        id: slice.id,
        notionalUsd: Number(notionalUsd.toFixed(2)),
        buyVenue: slice.buy.venue,
        sellVenue: slice.sell.venue,
        latencyGapMs: slice.latencyGapMs,
        queuePosition: queueEstimate.queuePosition,
        fillUrgency: queueEstimate.fillUrgency,
      });
      remaining -= notionalUsd;
    }
    return slices.length > 0 ? slices : [{
      id: "slice-1",
      notionalUsd: requestedNotionalUsd,
      buyVenue: opportunity.buyVenue,
      sellVenue: opportunity.sellVenue,
      latencyGapMs: toNumber(opportunity.latencyPrediction?.expectedLag, 0),
      queuePosition: opportunity.averageQueuePosition,
      fillUrgency: opportunity.shouldReprice ? "blocked" : "working",
    }];
  }

  private aggregateExecutionResults(results: ExecutionFnResult[], venue: string): ExecutionFnResult {
    const payloads = results
      .map((result) => result.payload)
      .filter((payload): payload is JsonMap => Boolean(payload));
    const childCount = results.length;
    const okCount = results.filter((result) => result.ok).length;
    return {
      ok: okCount === childCount && childCount > 0,
      venue,
      error: results.find((result) => !result.ok)?.error,
      payload: {
        venue,
        child_orders: payloads,
        child_count: childCount,
        ok_count: okCount,
        latency_ms: average(payloads.map((payload) => toNumber(payload.latency_ms ?? payload.latency_e2e_ms, 0))),
        latency_e2e_ms: average(payloads.map((payload) => toNumber(payload.latency_ms ?? payload.latency_e2e_ms, 0))),
        realized_slippage_bps: average(payloads.map((payload) => toNumber(payload.realized_slippage_bps, 0))),
        executed_notional_usd: payloads.reduce((sum, payload) => sum + toNumber(payload.notional ?? payload.executed_notional_usd, 0), 0),
      },
    };
  }

  private async wait(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  }
}