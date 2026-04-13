export type VenueQuoteSnapshot = {
  venue: string;
  bid: number;
  ask: number;
  latencyMs: number;
  slippageBps: number;
  feeBps: number;
  availableDepthUsd: number;
};

export type VenueExecutionRanking = {
  venue: string;
  totalCostBps: number;
  executable: boolean;
  latencyMs: number;
  availableDepthUsd: number;
};

export type VenueArbitrageOpportunity = {
  executable: boolean;
  buyVenue: string;
  sellVenue: string;
  grossEdgeBps: number;
  netEdgeBps: number;
  maxExecutableUsd: number;
  rankings: VenueExecutionRanking[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeVenue(venue: string): string {
  return String(venue || "").trim().toLowerCase() || "unknown";
}

function normalizedMidPrice(quote: VenueQuoteSnapshot): number {
  const bid = Math.max(0, quote.bid || 0);
  const ask = Math.max(0, quote.ask || 0);
  if (bid > 0 && ask > 0) {
    return (bid + ask) * 0.5;
  }
  return Math.max(bid, ask, 0);
}

function totalExecutionCostBps(quote: VenueQuoteSnapshot): number {
  return Math.max(0, quote.slippageBps) + Math.max(0, quote.feeBps) + clamp(Math.max(0, quote.latencyMs) / 25, 0, 8);
}

export function rankExecutionVenues(quotes: VenueQuoteSnapshot[]): VenueExecutionRanking[] {
  return quotes
    .filter((quote) => normalizedMidPrice(quote) > 0)
    .map((quote) => ({
      venue: normalizeVenue(quote.venue),
      totalCostBps: Number(totalExecutionCostBps(quote).toFixed(4)),
      executable: Math.max(0, quote.availableDepthUsd) > 0,
      latencyMs: Math.max(0, quote.latencyMs),
      availableDepthUsd: Math.max(0, quote.availableDepthUsd),
    }))
    .sort((left, right) => left.totalCostBps - right.totalCostBps || right.availableDepthUsd - left.availableDepthUsd);
}

export function evaluateVenueArbitrage(quotes: VenueQuoteSnapshot[]): VenueArbitrageOpportunity {
  const normalized = quotes.filter((quote) => normalizedMidPrice(quote) > 0);
  const rankings = rankExecutionVenues(normalized);
  if (normalized.length < 2) {
    return {
      executable: false,
      buyVenue: "none",
      sellVenue: "none",
      grossEdgeBps: 0,
      netEdgeBps: 0,
      maxExecutableUsd: 0,
      rankings,
    };
  }

  const buyQuote = [...normalized].sort((left, right) => left.ask - right.ask)[0];
  const sellQuote = [...normalized].sort((left, right) => right.bid - left.bid)[0];
  const mid = Math.max(normalizedMidPrice(buyQuote), normalizedMidPrice(sellQuote), 1e-9);
  const grossEdgeBps = ((sellQuote.bid - buyQuote.ask) / mid) * 10000;
  const netEdgeBps = grossEdgeBps - totalExecutionCostBps(buyQuote) - totalExecutionCostBps(sellQuote);
  const maxExecutableUsd = Math.max(0, Math.min(buyQuote.availableDepthUsd, sellQuote.availableDepthUsd));

  return {
    executable: netEdgeBps > 0 && maxExecutableUsd > 0 && normalizeVenue(buyQuote.venue) !== normalizeVenue(sellQuote.venue),
    buyVenue: normalizeVenue(buyQuote.venue),
    sellVenue: normalizeVenue(sellQuote.venue),
    grossEdgeBps: Number(grossEdgeBps.toFixed(4)),
    netEdgeBps: Number(netEdgeBps.toFixed(4)),
    maxExecutableUsd: Number(maxExecutableUsd.toFixed(2)),
    rankings,
  };
}