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
  routeMode: V7RouteMode;
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
    }

    const shouldExecute = Boolean(
      opportunity
      && frameLocked
      && opportunity.confidence > 0.6
      && opportunity.expectedNetEdgeBps > 0
      && opportunity.expectedNetEdgeBps > opportunity.expectedSlippageBps
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
  }> {
    const [buy, sell] = await Promise.all([
      params.sendOrder(params.buyOrder),
      params.sendOrder(params.sellOrder),
    ]);

    let hedged = false;
    if (buy.ok !== sell.ok && params.hedgeImmediately) {
      const succeeded = buy.ok ? buy : sell;
      const failedLeg = buy.ok ? "sell" : "buy";
      await params.hedgeImmediately(failedLeg, succeeded);
      hedged = true;
    }

    return {
      ok: buy.ok && sell.ok,
      buy,
      sell,
      hedged,
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
    const baseSpreadBps = Math.max(
      spreadBps,
      toNumber(bestCandidate?.spreadBps, 0),
      toNumber(backupCandidate?.spreadBps, 0),
      0.1,
    );
    const expectedSlippageBps = clamp(baseSpreadBps * volatilityFactor * latencyFactor * 0.12, 0.1, 50);
    const expectedNetEdgeBps = spreadBps - latencyCostBps - input.feePenaltyBps;
    const confidenceInputs = [
      toNumber(bestCandidate?.fillProbability, 0),
      toNumber(backupCandidate?.fillProbability, 0),
      clamp(1 - expectedSlippageBps / 25, 0, 1),
      clamp(1 - latencyCostBps / 20, 0, 1),
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
      routeMode,
    };
  }
}