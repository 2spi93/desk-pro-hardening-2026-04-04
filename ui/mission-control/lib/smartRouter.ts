import type { AggregatedOrderbook, MultiExchangeLevel } from "./multiExchangeBus";

export type SmartRouteOrder = {
  venue: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  notionalUsd: number;
  sharePct: number;
  expectedLatencyMs: number;
  expectedFillProbability: number;
  routeScore: number;
};

export type SmartRoutePlan = {
  orders: SmartRouteOrder[];
  requestedNotionalUsd: number;
  routedNotionalUsd: number;
  remainingNotionalUsd: number;
  coverageRatio: number;
  estimatedAveragePrice: number;
  estimatedSlippageBps: number;
  primaryVenue: string | null;
  venueCount: number;
};

type RouteOrderInput = {
  side: "buy" | "sell";
  notionalUsd: number;
  aggregatedBook: AggregatedOrderbook;
  maxOrders?: number;
  minOrderNotionalUsd?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function collapseVenueOrders(orders: SmartRouteOrder[], requestedNotionalUsd: number): SmartRouteOrder[] {
  const grouped = new Map<string, SmartRouteOrder>();
  for (const order of orders) {
    const existing = grouped.get(order.venue);
    if (!existing) {
      grouped.set(order.venue, { ...order });
      continue;
    }
    const totalNotional = existing.notionalUsd + order.notionalUsd;
    const weightedPrice = totalNotional > 0
      ? ((existing.price * existing.notionalUsd) + (order.price * order.notionalUsd)) / totalNotional
      : order.price;
    grouped.set(order.venue, {
      ...existing,
      price: weightedPrice,
      size: existing.size + order.size,
      notionalUsd: totalNotional,
      sharePct: requestedNotionalUsd > 0 ? totalNotional / requestedNotionalUsd : 0,
      expectedLatencyMs: Math.max(existing.expectedLatencyMs, order.expectedLatencyMs),
      expectedFillProbability: clamp((existing.expectedFillProbability + order.expectedFillProbability) * 0.5, 0, 1),
      routeScore: Math.max(existing.routeScore, order.routeScore),
    });
  }
  return [...grouped.values()].sort((left, right) => right.notionalUsd - left.notionalUsd);
}

function computeReferencePrice(levels: MultiExchangeLevel[], fallback = 0): number {
  return levels[0]?.price || fallback;
}

export function routeOrder(input: RouteOrderInput): SmartRoutePlan {
  const requestedNotionalUsd = Math.max(0, input.notionalUsd);
  const minOrderNotionalUsd = Math.max(1, input.minOrderNotionalUsd ?? 25);
  const maxOrders = Math.max(1, Math.min(8, input.maxOrders ?? 4));
  const levels = input.side === "buy" ? input.aggregatedBook.asks : input.aggregatedBook.bids;
  const referencePrice = computeReferencePrice(levels);
  let remainingNotionalUsd = requestedNotionalUsd;
  const rawOrders: SmartRouteOrder[] = [];

  for (const level of levels) {
    if (remainingNotionalUsd <= 0 || rawOrders.length >= maxOrders) {
      break;
    }
    const levelCapacityUsd = Math.max(0, level.notionalUsd || level.price * level.size);
    if (!(level.price > 0) || !(levelCapacityUsd > 0)) {
      continue;
    }
    const takeNotionalUsd = Math.min(levelCapacityUsd, remainingNotionalUsd);
    if (takeNotionalUsd < minOrderNotionalUsd && remainingNotionalUsd > minOrderNotionalUsd) {
      continue;
    }
    rawOrders.push({
      venue: level.venue,
      side: input.side,
      price: level.price,
      size: takeNotionalUsd / Math.max(level.price, 1e-9),
      notionalUsd: takeNotionalUsd,
      sharePct: requestedNotionalUsd > 0 ? takeNotionalUsd / requestedNotionalUsd : 0,
      expectedLatencyMs: level.latencyMs,
      expectedFillProbability: level.fillProbability,
      routeScore: level.routeScore,
    });
    remainingNotionalUsd = Math.max(0, Number((remainingNotionalUsd - takeNotionalUsd).toFixed(2)));
  }

  const orders = collapseVenueOrders(rawOrders, requestedNotionalUsd);
  const routedNotionalUsd = orders.reduce((sum, order) => sum + order.notionalUsd, 0);
  const estimatedAveragePrice = routedNotionalUsd > 0
    ? orders.reduce((sum, order) => sum + order.price * order.notionalUsd, 0) / routedNotionalUsd
    : 0;
  const estimatedSlippageBps = referencePrice > 0 && estimatedAveragePrice > 0
    ? Math.abs((estimatedAveragePrice - referencePrice) / referencePrice) * 10000
    : 0;

  return {
    orders,
    requestedNotionalUsd,
    routedNotionalUsd: Number(routedNotionalUsd.toFixed(2)),
    remainingNotionalUsd,
    coverageRatio: requestedNotionalUsd > 0 ? clamp(routedNotionalUsd / requestedNotionalUsd, 0, 1) : 0,
    estimatedAveragePrice: Number(estimatedAveragePrice.toFixed(8)),
    estimatedSlippageBps: Number(estimatedSlippageBps.toFixed(4)),
    primaryVenue: orders[0]?.venue || null,
    venueCount: orders.length,
  };
}