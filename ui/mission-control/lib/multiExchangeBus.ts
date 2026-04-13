export type MultiExchangeLevel = {
  venue: string;
  side: "bid" | "ask";
  price: number;
  size: number;
  notionalUsd: number;
  latencyMs: number;
  feeBps: number;
  fillProbability: number;
  routeScore: number;
};

export type VenueOrderbook = {
  venue: string;
  bids: MultiExchangeLevel[];
  asks: MultiExchangeLevel[];
  bestBid: number;
  bestAsk: number;
  availableDepthUsd: number;
  latencyMs: number;
  feeBps: number;
  fillProbability: number;
  routeScore: number;
};

export type AggregatedOrderbook = {
  bids: MultiExchangeLevel[];
  asks: MultiExchangeLevel[];
  venues: string[];
  bestBid: number;
  bestBidVenue: string | null;
  bestAsk: number;
  bestAskVenue: string | null;
  totalBidNotionalUsd: number;
  totalAskNotionalUsd: number;
};

export type MultiExchangeArbPlanLeg = {
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

export type MultiExchangeArbPlanSlice = {
  id: string;
  notionalUsd: number;
  quantity: number;
  grossSpread: number;
  grossSpreadBps: number;
  netSpreadBps: number;
  latencyGapMs: number;
  buy: MultiExchangeArbPlanLeg;
  sell: MultiExchangeArbPlanLeg;
};

export type MultiExchangeArbExecutionPlan = {
  slices: MultiExchangeArbPlanSlice[];
  totalNotionalUsd: number;
  weightedBuyPrice: number;
  weightedSellPrice: number;
  weightedGrossSpreadBps: number;
  weightedNetSpreadBps: number;
  weightedLatencyGapMs: number;
};

export type MultiExchangeArbitrageSnapshot = {
  arbitrage: boolean;
  executable: boolean;
  buyVenue: string | null;
  sellVenue: string | null;
  buyPrice: number;
  sellPrice: number;
  grossSpread: number;
  grossSpreadBps: number;
  netSpreadBps: number;
  latencyGapMs: number;
  opportunityScore: number;
  maxExecutableUsd: number;
  rankings: Array<{
    venue: string;
    latencyMs: number;
    availableDepthUsd: number;
    feeBps: number;
    fillProbability: number;
    routeScore: number;
  }>;
  opportunities: Array<{
    buyVenue: string;
    sellVenue: string;
    buyPrice: number;
    sellPrice: number;
    grossSpread: number;
    grossSpreadBps: number;
    netSpreadBps: number;
    latencyGapMs: number;
    opportunityScore: number;
    maxExecutableUsd: number;
    executable: boolean;
    executionPlan: MultiExchangeArbExecutionPlan | null;
  }>;
  executionPlan: MultiExchangeArbExecutionPlan | null;
  opportunity: boolean;
  buy: string | null;
  sell: string | null;
  net_spread: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeVenue(value: string): string {
  return String(value || "").trim().toLowerCase() || "unknown";
}

function safeNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeLevels(levels: MultiExchangeLevel[], side: "bid" | "ask"): MultiExchangeLevel[] {
  return levels
    .map((level) => ({
      ...level,
      venue: normalizeVenue(level.venue),
      side,
      price: Math.max(0, safeNumber(level.price, 0)),
      size: Math.max(0, safeNumber(level.size, 0)),
      notionalUsd: Math.max(0, safeNumber(level.notionalUsd, safeNumber(level.price, 0) * safeNumber(level.size, 0))),
      latencyMs: Math.max(0, safeNumber(level.latencyMs, 0)),
      feeBps: Math.max(0, safeNumber(level.feeBps, 0)),
      fillProbability: clamp(safeNumber(level.fillProbability, 0), 0, 1),
      routeScore: Math.max(0, safeNumber(level.routeScore, 0)),
    }))
    .filter((level) => level.price > 0 && (level.size > 0 || level.notionalUsd > 0));
}

function executionPenaltyBps(input: { latencyMs: number; feeBps: number; fillProbability: number; routeScore: number }): number {
  const latencyPenalty = clamp(input.latencyMs / 35, 0, 18);
  const fillPenalty = clamp((1 - input.fillProbability) * 12, 0, 10);
  const routePenalty = clamp((1 - Math.min(1, Math.max(0, input.routeScore))) * 6, 0, 6);
  return Math.max(0, input.feeBps) + latencyPenalty + fillPenalty + routePenalty;
}

function buildDepthExecutionPlan(buyAsks: MultiExchangeLevel[], sellBids: MultiExchangeLevel[]): MultiExchangeArbExecutionPlan | null {
  if (buyAsks.length === 0 || sellBids.length === 0) {
    return null;
  }

  const askRemainders = buyAsks.map((level) => Math.max(0, level.notionalUsd));
  const bidRemainders = sellBids.map((level) => Math.max(0, level.notionalUsd));
  const slices: MultiExchangeArbPlanSlice[] = [];
  let askIndex = 0;
  let bidIndex = 0;

  while (askIndex < buyAsks.length && bidIndex < sellBids.length && slices.length < 12) {
    const askLevel = buyAsks[askIndex];
    const bidLevel = sellBids[bidIndex];
    const askRemaining = askRemainders[askIndex] || 0;
    const bidRemaining = bidRemainders[bidIndex] || 0;
    if (!(askRemaining > 0)) {
      askIndex += 1;
      continue;
    }
    if (!(bidRemaining > 0)) {
      bidIndex += 1;
      continue;
    }
    if (!(bidLevel.price > askLevel.price)) {
      break;
    }

    const notionalUsd = Math.min(askRemaining, bidRemaining);
    const mid = Math.max((bidLevel.price + askLevel.price) * 0.5, 1e-9);
    const grossSpread = bidLevel.price - askLevel.price;
    const grossSpreadBps = grossSpread / mid * 10000;
    const buyPenaltyBps = executionPenaltyBps({
      latencyMs: askLevel.latencyMs,
      feeBps: askLevel.feeBps,
      fillProbability: askLevel.fillProbability,
      routeScore: askLevel.routeScore,
    });
    const sellPenaltyBps = executionPenaltyBps({
      latencyMs: bidLevel.latencyMs,
      feeBps: bidLevel.feeBps,
      fillProbability: bidLevel.fillProbability,
      routeScore: bidLevel.routeScore,
    });
    const netSpreadBps = grossSpreadBps - buyPenaltyBps - sellPenaltyBps;
    if (!(netSpreadBps > 0) || !(notionalUsd >= 1)) {
      break;
    }

    const quantity = notionalUsd / Math.max(askLevel.price, bidLevel.price, 1e-9);
    slices.push({
      id: `arb-slice-${askIndex + 1}-${bidIndex + 1}`,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      quantity: Number(quantity.toFixed(8)),
      grossSpread: Number(grossSpread.toFixed(8)),
      grossSpreadBps: Number(grossSpreadBps.toFixed(4)),
      netSpreadBps: Number(netSpreadBps.toFixed(4)),
      latencyGapMs: Number(Math.abs(askLevel.latencyMs - bidLevel.latencyMs).toFixed(2)),
      buy: {
        venue: askLevel.venue,
        price: askLevel.price,
        size: askLevel.size,
        notionalUsd: Number(notionalUsd.toFixed(2)),
        latencyMs: askLevel.latencyMs,
        feeBps: askLevel.feeBps,
        fillProbability: askLevel.fillProbability,
        routeScore: askLevel.routeScore,
        levelIndex: askIndex,
      },
      sell: {
        venue: bidLevel.venue,
        price: bidLevel.price,
        size: bidLevel.size,
        notionalUsd: Number(notionalUsd.toFixed(2)),
        latencyMs: bidLevel.latencyMs,
        feeBps: bidLevel.feeBps,
        fillProbability: bidLevel.fillProbability,
        routeScore: bidLevel.routeScore,
        levelIndex: bidIndex,
      },
    });

    askRemainders[askIndex] = Math.max(0, askRemaining - notionalUsd);
    bidRemainders[bidIndex] = Math.max(0, bidRemaining - notionalUsd);
    if (askRemainders[askIndex] <= 0.0001) {
      askIndex += 1;
    }
    if (bidRemainders[bidIndex] <= 0.0001) {
      bidIndex += 1;
    }
  }

  if (slices.length === 0) {
    return null;
  }

  const totalNotionalUsd = slices.reduce((sum, slice) => sum + slice.notionalUsd, 0);
  const weighted = <T extends number>(value: (slice: MultiExchangeArbPlanSlice) => T): number => {
    if (!(totalNotionalUsd > 0)) {
      return 0;
    }
    return slices.reduce((sum, slice) => sum + value(slice) * slice.notionalUsd, 0) / totalNotionalUsd;
  };

  return {
    slices,
    totalNotionalUsd: Number(totalNotionalUsd.toFixed(2)),
    weightedBuyPrice: Number(weighted((slice) => slice.buy.price).toFixed(8)),
    weightedSellPrice: Number(weighted((slice) => slice.sell.price).toFixed(8)),
    weightedGrossSpreadBps: Number(weighted((slice) => slice.grossSpreadBps).toFixed(4)),
    weightedNetSpreadBps: Number(weighted((slice) => slice.netSpreadBps).toFixed(4)),
    weightedLatencyGapMs: Number(weighted((slice) => slice.latencyGapMs).toFixed(2)),
  };
}

function rankVenues(orderbooks: VenueOrderbook[]) {
  return orderbooks
    .map((orderbook) => ({
      venue: normalizeVenue(orderbook.venue),
      latencyMs: Math.max(0, safeNumber(orderbook.latencyMs, 0)),
      availableDepthUsd: Math.max(0, safeNumber(orderbook.availableDepthUsd, 0)),
      feeBps: Math.max(0, safeNumber(orderbook.feeBps, 0)),
      fillProbability: clamp(safeNumber(orderbook.fillProbability, 0), 0, 1),
      routeScore: Math.max(0, safeNumber(orderbook.routeScore, 0)),
    }))
    .sort((left, right) => {
      const leftScore = left.availableDepthUsd * 0.0001 + left.routeScore * 25 + left.fillProbability * 20 - left.latencyMs * 0.12 - left.feeBps;
      const rightScore = right.availableDepthUsd * 0.0001 + right.routeScore * 25 + right.fillProbability * 20 - right.latencyMs * 0.12 - right.feeBps;
      return rightScore - leftScore;
    });
}

export function aggregateOrderbooks(orderbooks: VenueOrderbook[]): AggregatedOrderbook {
  const bids = orderbooks.flatMap((orderbook) => normalizeLevels(orderbook.bids, "bid"));
  const asks = orderbooks.flatMap((orderbook) => normalizeLevels(orderbook.asks, "ask"));

  bids.sort((left, right) => right.price - left.price || right.notionalUsd - left.notionalUsd || left.latencyMs - right.latencyMs);
  asks.sort((left, right) => left.price - right.price || right.notionalUsd - left.notionalUsd || left.latencyMs - right.latencyMs);

  return {
    bids,
    asks,
    venues: [...new Set(orderbooks.map((orderbook) => normalizeVenue(orderbook.venue)).filter(Boolean))],
    bestBid: bids[0]?.price || 0,
    bestBidVenue: bids[0]?.venue || null,
    bestAsk: asks[0]?.price || 0,
    bestAskVenue: asks[0]?.venue || null,
    totalBidNotionalUsd: bids.reduce((sum, level) => sum + level.notionalUsd, 0),
    totalAskNotionalUsd: asks.reduce((sum, level) => sum + level.notionalUsd, 0),
  };
}

export function detectArbitrage(orderbooks: VenueOrderbook[]): MultiExchangeArbitrageSnapshot {
  const rankings = rankVenues(orderbooks);
  const aggregated = aggregateOrderbooks(orderbooks);
  if (orderbooks.length < 2) {
    return {
      arbitrage: false,
      executable: false,
      buyVenue: null,
      sellVenue: null,
      buyPrice: 0,
      sellPrice: 0,
      grossSpread: 0,
      grossSpreadBps: 0,
      netSpreadBps: 0,
      latencyGapMs: 0,
      opportunityScore: 0,
      maxExecutableUsd: 0,
      rankings,
      opportunities: [],
      executionPlan: null,
      opportunity: false,
      buy: null,
      sell: null,
      net_spread: 0,
    };
  }

  const opportunities = orderbooks.flatMap((buyBook) => {
    const buyAsk = normalizeLevels(buyBook.asks, "ask")[0] || null;
    if (!buyAsk) {
      return [] as MultiExchangeArbitrageSnapshot["opportunities"];
    }
    return orderbooks
      .filter((sellBook) => normalizeVenue(sellBook.venue) !== normalizeVenue(buyBook.venue))
      .map((sellBook) => {
        const sellBids = normalizeLevels(sellBook.bids, "bid");
        const sellBid = sellBids[0] || null;
        if (!sellBid) {
          return null;
        }
        const buyAsks = normalizeLevels(buyBook.asks, "ask");
        const executionPlan = buildDepthExecutionPlan(buyAsks, sellBids);
        const mid = Math.max((sellBid.price + buyAsk.price) * 0.5, 1e-9);
        const grossSpread = sellBid.price - buyAsk.price;
        const grossSpreadBps = executionPlan?.weightedGrossSpreadBps ?? (grossSpread / mid) * 10000;
        const netSpreadBps = executionPlan?.weightedNetSpreadBps ?? 0;
        const maxExecutableUsd = executionPlan?.totalNotionalUsd ?? 0;
        const latencyGapMs = executionPlan?.weightedLatencyGapMs ?? Math.abs(buyAsk.latencyMs - sellBid.latencyMs);
        const depthScore = clamp(Math.log10(Math.max(10, maxExecutableUsd)) / 4.5, 0, 1);
        const latencyScore = clamp(1 - latencyGapMs / 450, 0, 1);
        const executionConfidence = clamp((buyAsk.fillProbability + sellBid.fillProbability) * 0.5, 0, 1);
        const opportunityScore = clamp(netSpreadBps * 0.72 + depthScore * 6 + latencyScore * 3 + executionConfidence * 4, -50, 250);
        const executable = grossSpread > 0 && netSpreadBps > 0 && maxExecutableUsd >= 25 && latencyGapMs <= 800;
        return {
          buyVenue: buyAsk.venue,
          sellVenue: sellBid.venue,
          buyPrice: executionPlan?.weightedBuyPrice ?? buyAsk.price,
          sellPrice: executionPlan?.weightedSellPrice ?? sellBid.price,
          grossSpread: Number(grossSpread.toFixed(8)),
          grossSpreadBps: Number(grossSpreadBps.toFixed(4)),
          netSpreadBps: Number(netSpreadBps.toFixed(4)),
          latencyGapMs: Number(latencyGapMs.toFixed(2)),
          opportunityScore: Number(opportunityScore.toFixed(4)),
          maxExecutableUsd: Number(maxExecutableUsd.toFixed(2)),
          executable,
          executionPlan,
        };
      })
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  }).sort((left, right) => right.opportunityScore - left.opportunityScore || right.netSpreadBps - left.netSpreadBps);

  const best = opportunities[0] || null;
  const fallbackBid = aggregated.bids[0] || null;
  const fallbackAsk = aggregated.asks[0] || null;
  if (!best && (!fallbackBid || !fallbackAsk)) {
    return {
      arbitrage: false,
      executable: false,
      buyVenue: null,
      sellVenue: null,
      buyPrice: 0,
      sellPrice: 0,
      grossSpread: 0,
      grossSpreadBps: 0,
      netSpreadBps: 0,
      latencyGapMs: 0,
      opportunityScore: 0,
      maxExecutableUsd: 0,
      rankings,
      opportunities,
      executionPlan: null,
      opportunity: false,
      buy: null,
      sell: null,
      net_spread: 0,
    };
  }

  const resolvedBuyVenue = best?.buyVenue || fallbackAsk?.venue || null;
  const resolvedSellVenue = best?.sellVenue || fallbackBid?.venue || null;
  const resolvedGrossSpread = best?.grossSpread || 0;
  const resolvedGrossSpreadBps = best?.grossSpreadBps || 0;
  const resolvedNetSpreadBps = best?.netSpreadBps || 0;
  const resolvedExecutableUsd = best?.maxExecutableUsd || 0;
  const resolvedExecutable = Boolean(best?.executable);
  const resolvedExecutionPlan = best?.executionPlan || null;

  return {
    arbitrage: resolvedExecutable,
    executable: resolvedExecutable,
    buyVenue: resolvedBuyVenue,
    sellVenue: resolvedSellVenue,
    buyPrice: best?.buyPrice || fallbackAsk?.price || 0,
    sellPrice: best?.sellPrice || fallbackBid?.price || 0,
    grossSpread: Number(resolvedGrossSpread.toFixed(8)),
    grossSpreadBps: Number(resolvedGrossSpreadBps.toFixed(4)),
    netSpreadBps: Number(resolvedNetSpreadBps.toFixed(4)),
    latencyGapMs: Number((best?.latencyGapMs || 0).toFixed(2)),
    opportunityScore: Number((best?.opportunityScore || 0).toFixed(4)),
    maxExecutableUsd: Number(resolvedExecutableUsd.toFixed(2)),
    rankings,
    opportunities: opportunities.slice(0, 8),
    executionPlan: resolvedExecutionPlan,
    opportunity: resolvedExecutable,
    buy: resolvedBuyVenue,
    sell: resolvedSellVenue,
    net_spread: Number(resolvedNetSpreadBps.toFixed(4)),
  };
}