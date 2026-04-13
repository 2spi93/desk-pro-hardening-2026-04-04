export type SimulationLevel = {
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
};

export type OrderBookState = {
  bids: SimulationLevel[];
  asks: SimulationLevel[];
  bestBid: number;
  bestAsk: number;
  bidVolume: number;
  askVolume: number;
  touchDepth: number;
  depth: number;
  spread: number;
  imbalance: number;
  liquidityVacuum: number;
};

export type FlowBucket = {
  buyVolume: number;
  sellVolume: number;
  delta: number;
};

export type ExecutionPreview = {
  fillProbability: number;
  slippageBps: number;
  latencyMs: number;
  routeScore: number;
  edgeBps: number;
  blockedRatio: number;
  partialFillRatio: number;
  confidence: number;
};

export type FlowState = {
  buyVolume: number;
  sellVolume: number;
  delta: number;
  imbalance: number;
  absorption: number;
  execution: ExecutionPreview;
};

export type SimState = {
  price: number;
  orderBook: OrderBookState;
  flow: FlowState;
  volatility: number;
  latency: number;
  slippageBps: number;
  routeScore: number;
  edgeBps: number;
};

export type SimulationHorizon = {
  horizonMs: number;
  price: number;
  moveBps: number;
  fillProbability: number;
  slippageBps: number;
  latencyMs: number;
  liquidityCollapse: boolean;
  confidence: number;
};

export type MarketSimulationStateLabel =
  | "aggressive_buy"
  | "aggressive_sell"
  | "breakout"
  | "chaos"
  | "neutral";

export type ExecutionDecision = {
  shouldExecute: boolean;
  action: "buy" | "sell" | "hold";
  confidence: number;
  reason: string;
};

export type ExecutionCone = {
  best: number;
  expected: number;
  worst: number;
  confidence: number;
};

export type MarketSimulation = {
  imbalance: number;
  liquidityCollapse: boolean;
  stateLabel: MarketSimulationStateLabel;
  confidence: number;
  t100ms: SimulationHorizon;
  t250ms: SimulationHorizon;
  t500ms: SimulationHorizon;
  cone: ExecutionCone;
  execution: {
    fillProb: number;
    slippage: number;
    latency: number;
  };
  decision: ExecutionDecision;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function safeAverage(values: number[], fallback = 0): number {
  if (values.length === 0) {
    return fallback;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function computeImbalance(book: Pick<OrderBookState, "bidVolume" | "askVolume">): number {
  const bidVolume = Math.max(0, book.bidVolume);
  const askVolume = Math.max(0, book.askVolume);
  const total = bidVolume + askVolume;
  if (total <= 0) {
    return 0;
  }
  return clamp((bidVolume - askVolume) / total, -1, 1);
}

export function detectLiquidityVacuum(book: Pick<OrderBookState, "depth" | "touchDepth" | "spread" | "bestAsk" | "bestBid">): boolean {
  const spreadStress = clamp(book.spread / Math.max(0.0001, Math.max(book.bestAsk || 0, book.bestBid || 0, 1)) * 4000, 0, 1);
  return book.depth < 220 || book.touchDepth < 56 || spreadStress > 0.42;
}

export function projectPrice(price: number, imbalance: number, volatility: number, horizonMs: number, liquidityVacuum = 0): number {
  const normalizedVolatility = Math.max(0.0001, volatility || 0.0001);
  const horizonFactor = Math.sqrt(Math.max(1, horizonMs) / 100);
  const imbalanceDrift = imbalance * normalizedVolatility * horizonFactor * 0.8;
  const vacuumDrift = Math.sign(imbalance || 1) * liquidityVacuum * normalizedVolatility * horizonFactor * 0.55;
  return price * (1 + imbalanceDrift + vacuumDrift);
}

export function buildOrderBookState(levels: SimulationLevel[]): OrderBookState {
  const bids = levels
    .filter((level) => level.side === "bid" && Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((left, right) => right.price - left.price)
    .slice(0, 12);
  const asks = levels
    .filter((level) => level.side === "ask" && Number.isFinite(level.price) && Number.isFinite(level.size))
    .sort((left, right) => left.price - right.price)
    .slice(0, 12);
  const bidVolume = bids.reduce((sum, level) => sum + Math.max(0, level.size) * Math.max(0.2, level.intensity || 0), 0);
  const askVolume = asks.reduce((sum, level) => sum + Math.max(0, level.size) * Math.max(0.2, level.intensity || 0), 0);
  const touchDepth = bids.slice(0, 3).reduce((sum, level) => sum + Math.max(0, level.size), 0)
    + asks.slice(0, 3).reduce((sum, level) => sum + Math.max(0, level.size), 0);
  const depth = bidVolume + askVolume;
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? bestBid;
  const spread = bestBid > 0 && bestAsk > 0 ? Math.max(0, bestAsk - bestBid) : 0;
  const imbalance = computeImbalance({ bidVolume, askVolume });
  const liquidityVacuum = clamp(1 - Math.min(1, depth / 1800), 0, 1) * 0.65 + clamp(1 - Math.min(1, touchDepth / 260), 0, 1) * 0.35;

  return {
    bids,
    asks,
    bestBid,
    bestAsk,
    bidVolume,
    askVolume,
    touchDepth,
    depth,
    spread,
    imbalance,
    liquidityVacuum: clamp(liquidityVacuum, 0, 1),
  };
}

export function buildFlowState(buckets: FlowBucket[], execution: ExecutionPreview): FlowState {
  const buyVolume = buckets.reduce((sum, bucket) => sum + Math.max(0, bucket.buyVolume), 0);
  const sellVolume = buckets.reduce((sum, bucket) => sum + Math.max(0, bucket.sellVolume), 0);
  const totalVolume = buyVolume + sellVolume;
  const delta = buckets.reduce((sum, bucket) => sum + (Number.isFinite(bucket.delta) ? bucket.delta : bucket.buyVolume - bucket.sellVolume), 0);
  const imbalance = totalVolume > 0 ? clamp(delta / totalVolume, -1, 1) : 0;
  const absorption = totalVolume > 0
    ? clamp((1 - Math.abs(imbalance)) * 0.58 + Math.min(1, totalVolume / 1800) * 0.42, 0, 1)
    : 0;

  return {
    buyVolume,
    sellVolume,
    delta,
    imbalance,
    absorption,
    execution,
  };
}

export function simulateExecution(state: SimState): { fillProb: number; slippage: number; latency: number } {
  const liquiditySupport = clamp(1 - state.orderBook.liquidityVacuum, 0, 1);
  const routeSupport = clamp(state.routeScore / 100, 0, 1);
  const fillProb = clamp(
    state.flow.execution.fillProbability * 0.46
      + liquiditySupport * 0.24
      + routeSupport * 0.18
      + (1 - state.flow.execution.blockedRatio) * 0.12,
    0,
    1,
  );
  const slippage = Math.max(
    0,
    state.slippageBps * (0.72 + state.orderBook.liquidityVacuum * 0.65 + Math.abs(state.flow.imbalance) * 0.28),
  );
  const latency = Math.max(
    0,
    state.latency * (0.86 + state.orderBook.liquidityVacuum * 0.32 + (1 - routeSupport) * 0.12),
  );
  return { fillProb, slippage, latency };
}

function simulateStep(state: SimState, horizonMs: number): SimulationHorizon {
  const bookImbalance = computeImbalance(state.orderBook);
  const flowLead = clamp(state.flow.imbalance * 0.58 + bookImbalance * 0.42, -1, 1);
  const liquidityCollapse = detectLiquidityVacuum(state.orderBook);
  const price = projectPrice(
    state.price,
    flowLead,
    state.volatility,
    horizonMs,
    liquidityCollapse ? Math.max(state.orderBook.liquidityVacuum, 0.38) : state.orderBook.liquidityVacuum * 0.55,
  );
  const execution = simulateExecution(state);
  const horizonFactor = Math.sqrt(Math.max(1, horizonMs) / 100);
  const fillProbability = clamp(execution.fillProb * (1 - (horizonFactor - 1) * 0.06), 0, 1);
  const slippageBps = execution.slippage * (0.92 + (horizonFactor - 1) * 0.22);
  const latencyMs = execution.latency + horizonMs * 0.08;
  const moveBps = state.price > 0 ? ((price - state.price) / state.price) * 10000 : 0;
  const confidence = clamp(
    Math.abs(flowLead) * 0.32
      + fillProbability * 0.28
      + (1 - Math.min(1, slippageBps / 22)) * 0.14
      + (1 - Math.min(1, latencyMs / 900)) * 0.12
      + (liquidityCollapse ? 0.08 : 0.14),
    0,
    1,
  );

  return {
    horizonMs,
    price,
    moveBps,
    fillProbability,
    slippageBps,
    latencyMs,
    liquidityCollapse,
    confidence,
  };
}

export function computeExecutionCone(simulation: {
  price: number;
  t100ms: SimulationHorizon;
  t250ms: SimulationHorizon;
  t500ms: SimulationHorizon;
  volatility: number;
  imbalance: number;
  liquidityVacuum: number;
}): ExecutionCone {
  const expected = simulation.t250ms.price;
  const confidence = clamp(
    safeAverage([
      simulation.t100ms.confidence,
      simulation.t250ms.confidence,
      simulation.t500ms.confidence,
    ], 0),
    0,
    1,
  );
  const rangePct = Math.max(0.0002, simulation.volatility * (0.45 + simulation.liquidityVacuum * 0.55 + Math.abs(simulation.imbalance) * 0.2));
  const range = simulation.price * rangePct;
  return {
    best: expected + range * (0.52 + confidence * 0.42),
    expected,
    worst: expected - range * (0.52 + (1 - confidence) * 0.28),
    confidence,
  };
}

export function classifyMarket(simulation: {
  imbalance: number;
  liquidityCollapse: boolean;
  volatility: number;
}): MarketSimulationStateLabel {
  if (simulation.volatility > 0.0075) {
    return "chaos";
  }
  if (simulation.liquidityCollapse) {
    return "breakout";
  }
  if (simulation.imbalance > 0.6) {
    return "aggressive_buy";
  }
  if (simulation.imbalance < -0.6) {
    return "aggressive_sell";
  }
  return "neutral";
}

export function shouldExecute(simulation: {
  fillProbability: number;
  slippageBps: number;
  confidence: number;
  edgeBps: number;
}): ExecutionDecision {
  const side = simulation.edgeBps >= 0 ? "buy" : "sell";
  if (simulation.fillProbability < 0.4) {
    return { shouldExecute: false, action: "hold", confidence: simulation.confidence, reason: "fill probability too low" };
  }
  if (simulation.slippageBps > Math.max(8, Math.abs(simulation.edgeBps) + 4)) {
    return { shouldExecute: false, action: "hold", confidence: simulation.confidence, reason: "slippage budget exceeded" };
  }
  if (simulation.confidence < 0.6) {
    return { shouldExecute: false, action: "hold", confidence: simulation.confidence, reason: "simulation confidence too low" };
  }
  return { shouldExecute: true, action: side, confidence: simulation.confidence, reason: "execution window validated" };
}

export function simulateMarket(state: SimState): MarketSimulation {
  const imbalance = clamp(state.flow.imbalance * 0.56 + state.orderBook.imbalance * 0.44, -1, 1);
  const liquidityCollapse = detectLiquidityVacuum(state.orderBook);
  const t100ms = simulateStep(state, 100);
  const t250ms = simulateStep(state, 250);
  const t500ms = simulateStep(state, 500);
  const confidence = clamp(safeAverage([t100ms.confidence, t250ms.confidence, t500ms.confidence], 0), 0, 1);
  const cone = computeExecutionCone({
    price: state.price,
    t100ms,
    t250ms,
    t500ms,
    volatility: state.volatility,
    imbalance,
    liquidityVacuum: state.orderBook.liquidityVacuum,
  });
  const marketState = classifyMarket({ imbalance, liquidityCollapse, volatility: state.volatility });
  const execution = simulateExecution(state);
  const decision = shouldExecute({
    fillProbability: execution.fillProb,
    slippageBps: execution.slippage,
    confidence,
    edgeBps: state.edgeBps,
  });

  return {
    imbalance,
    liquidityCollapse,
    stateLabel: marketState,
    confidence,
    t100ms,
    t250ms,
    t500ms,
    cone,
    execution,
    decision,
  };
}