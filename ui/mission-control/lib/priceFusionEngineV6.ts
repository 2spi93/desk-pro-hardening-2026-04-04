export type VenueTick = {
  venue: string;
  price: number;
  size: number;
  tsMs: number;
};

export type VenueQuote = {
  venue: string;
  bid: number;
  ask: number;
  last?: number;
  tsMs: number;
};

export type ArbOpportunity = {
  opportunity: boolean;
  spread: number;
  netSpread: number;
  buy: string;
  sell: string;
};

export type RouteCandidate = {
  venue: string;
  instrument?: string;
  score: number;
  liquidity: number;
  latency: number;
  fillProbability: number;
  spreadBps: number;
  freshnessMs: number;
  last: number;
  bid: number;
  ask: number;
};

export type PriceFusionSnapshot = {
  fusionPrice: number;
  predictedPrice: number;
  displayPrice: number;
  weightedMedianPrice: number;
  deviationBps: number;
  venueCount: number;
  bestBid: number;
  bestAsk: number;
  venues: Record<string, number>;
  arbitrage: ArbOpportunity;
  routeCandidates: RouteCandidate[];
  filteredTicks: VenueTick[];
};

const MAX_TICK_STALENESS_MS = 4_000;
const MAX_QUOTE_STALENESS_MS = 5_000;
const DEFAULT_FEE_BPS = 6;
const DEFAULT_LATENCY_COST_BPS = 1.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function midFromQuote(quote: VenueQuote): number {
  if (quote.bid > 0 && quote.ask > 0) {
    return (quote.bid + quote.ask) / 2;
  }
  return Math.max(0, quote.last || 0);
}

export function weightedMedian(ticks: VenueTick[]): number {
  if (ticks.length === 0) {
    return 0;
  }
  const sorted = [...ticks].sort((left, right) => left.price - right.price);
  const totalWeight = sorted.reduce((sum, tick) => sum + Math.max(0.000001, tick.size), 0);
  let cumulative = 0;
  for (const tick of sorted) {
    cumulative += Math.max(0.000001, tick.size);
    if (cumulative >= totalWeight / 2) {
      return tick.price;
    }
  }
  return sorted[sorted.length - 1]?.price || 0;
}

export function filterOutliers(ticks: VenueTick[], thresholdRatio = 0.002): VenueTick[] {
  if (ticks.length <= 2) {
    return ticks.filter((tick) => tick.price > 0 && tick.size > 0);
  }
  const prices = ticks
    .map((tick) => tick.price)
    .filter((price) => price > 0)
    .sort((left, right) => left - right);
  if (prices.length === 0) {
    return [];
  }
  const median = prices[Math.floor(prices.length / 2)] || 0;
  if (!(median > 0)) {
    return ticks.filter((tick) => tick.price > 0 && tick.size > 0);
  }
  const filtered = ticks.filter((tick) => tick.price > 0
    && tick.size > 0
    && Math.abs(tick.price - median) / median < thresholdRatio);
  return filtered.length > 0 ? filtered : ticks.filter((tick) => tick.price > 0 && tick.size > 0);
}

class PricePredictor {
  private last = 0;
  private velocity = 0;

  update(price: number): void {
    if (!(price > 0)) {
      return;
    }
    if (!(this.last > 0)) {
      this.last = price;
      this.velocity = 0;
      return;
    }
    const delta = price - this.last;
    this.velocity = 0.8 * this.velocity + 0.2 * delta;
    this.last = price;
  }

  predict(): number {
    if (!(this.last > 0)) {
      return 0;
    }
    return this.last + this.velocity;
  }
}

export class PriceFusionEngineV6 {
  private ticks = new Map<string, VenueTick>();
  private quotes = new Map<string, VenueQuote>();
  private latencyByVenue = new Map<string, number>();
  private liquidityByVenue = new Map<string, number>();
  private predictor = new PricePredictor();

  updateTick(tick: VenueTick): PriceFusionSnapshot {
    if (!(tick.price > 0) || !(tick.size > 0)) {
      return this.getSnapshot();
    }
    const now = Date.now();
    const latency = tick.tsMs > 0 ? clamp(now - tick.tsMs, 0, 10_000) : 0;
    const previousLatency = this.latencyByVenue.get(tick.venue) ?? latency;
    this.latencyByVenue.set(tick.venue, previousLatency * 0.7 + latency * 0.3);

    const previousLiquidity = this.liquidityByVenue.get(tick.venue) ?? tick.size * tick.price;
    const notionals = tick.size * tick.price;
    this.liquidityByVenue.set(tick.venue, previousLiquidity * 0.75 + notionals * 0.25);
    this.ticks.set(tick.venue, tick);

    const snapshot = this.getSnapshot();
    if (snapshot.fusionPrice > 0) {
      this.predictor.update(snapshot.fusionPrice);
    }
    return this.getSnapshot();
  }

  updateTickFast(venue: string, price: number, size: number, tsMs: number): PriceFusionSnapshot {
    return this.updateTick({ venue, price, size, tsMs });
  }

  updateQuote(quote: VenueQuote): PriceFusionSnapshot {
    const mid = midFromQuote(quote);
    if (!(mid > 0)) {
      return this.getSnapshot();
    }
    this.quotes.set(quote.venue, quote);
    const currentLiquidity = this.liquidityByVenue.get(quote.venue) ?? mid;
    const quotedLiquidity = Math.max(mid, (quote.ask - quote.bid) > 0 ? mid / (quote.ask - quote.bid) : mid);
    this.liquidityByVenue.set(quote.venue, currentLiquidity * 0.8 + quotedLiquidity * 0.2);
    return this.getSnapshot();
  }

  reset(): void {
    this.ticks.clear();
    this.quotes.clear();
    this.latencyByVenue.clear();
    this.liquidityByVenue.clear();
    this.predictor = new PricePredictor();
  }

  getSnapshot(): PriceFusionSnapshot {
    const now = Date.now();
    const liveTicks = [...this.ticks.values()].filter((tick) => now - tick.tsMs <= MAX_TICK_STALENESS_MS);
    const filteredTicks = filterOutliers(liveTicks);
    const fusionPrice = weightedMedian(filteredTicks);
    const predictedPrice = this.predictor.predict();
    const displayPrice = predictedPrice > 0 ? predictedPrice : fusionPrice;
    const prices = filteredTicks.map((tick) => tick.price);
    const deviationBps = prices.length >= 2 && fusionPrice > 0
      ? ((Math.max(...prices) - Math.min(...prices)) / fusionPrice) * 10_000
      : 0;

    const liveQuotes = [...this.quotes.values()].filter((quote) => now - quote.tsMs <= MAX_QUOTE_STALENESS_MS);
    let bestBid = 0;
    let bestAsk = 0;
    if (liveQuotes.length > 0) {
      bestBid = Math.max(...liveQuotes.map((quote) => quote.bid).filter((value) => value > 0), 0);
      const asks = liveQuotes.map((quote) => quote.ask).filter((value) => value > 0);
      bestAsk = asks.length > 0 ? Math.min(...asks) : 0;
    }
    const arbitrage = this.detectArb(liveQuotes, fusionPrice || displayPrice || bestBid || bestAsk);
    const routeCandidates = this.buildRouteCandidates(liveQuotes);

    return {
      fusionPrice,
      predictedPrice,
      displayPrice,
      weightedMedianPrice: fusionPrice,
      deviationBps,
      venueCount: filteredTicks.length,
      bestBid,
      bestAsk,
      venues: Object.fromEntries(filteredTicks.map((tick) => [tick.venue, tick.price])),
      arbitrage,
      routeCandidates,
      filteredTicks,
    };
  }

  private detectArb(quotes: VenueQuote[], referencePrice: number): ArbOpportunity {
    let bestBid = -Infinity;
    let bestAsk = Infinity;
    let bidVenue = "";
    let askVenue = "";

    for (const quote of quotes) {
      if (quote.bid > bestBid) {
        bestBid = quote.bid;
        bidVenue = quote.venue;
      }
      if (quote.ask > 0 && quote.ask < bestAsk) {
        bestAsk = quote.ask;
        askVenue = quote.venue;
      }
    }

    if (!(bestBid > 0) || !(bestAsk > 0)) {
      return { opportunity: false, spread: 0, netSpread: 0, buy: "", sell: "" };
    }

    const grossSpread = bestBid - bestAsk;
    const reference = referencePrice > 0 ? referencePrice : (bestBid + bestAsk) / 2;
    const feeCost = reference * (DEFAULT_FEE_BPS / 10_000);
    const latencyCost = reference * (DEFAULT_LATENCY_COST_BPS / 10_000);
    const netSpread = grossSpread - feeCost - latencyCost;
    return {
      opportunity: netSpread > 0,
      spread: grossSpread,
      netSpread,
      buy: askVenue,
      sell: bidVenue,
    };
  }

  private buildRouteCandidates(quotes: VenueQuote[]): RouteCandidate[] {
    const now = Date.now();
    return quotes
      .map((quote) => {
        const mid = midFromQuote(quote);
        const spreadBps = mid > 0 && quote.bid > 0 && quote.ask > 0
          ? ((quote.ask - quote.bid) / mid) * 10_000
          : 999;
        const latency = this.latencyByVenue.get(quote.venue) ?? 200;
        const liquidityRaw = this.liquidityByVenue.get(quote.venue) ?? mid;
        const liquidity = clamp(Math.log10(Math.max(10, liquidityRaw)) / 6, 0, 1);
        const fillProbability = clamp((1 - Math.min(spreadBps, 20) / 20) * 0.55 + liquidity * 0.45, 0.05, 0.99);
        const freshnessMs = Math.max(0, now - quote.tsMs);
        const score = liquidity * 0.4 + (1 / Math.max(1, latency)) * 100 * 0.3 + fillProbability * 0.3;
        return {
          venue: quote.venue,
          score,
          liquidity,
          latency,
          fillProbability,
          spreadBps,
          freshnessMs,
          last: mid,
          bid: quote.bid,
          ask: quote.ask,
        };
      })
      .sort((left, right) => right.score - left.score);
  }
}