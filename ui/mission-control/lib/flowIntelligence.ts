export type FlowTradeTick = {
  time: number;
  price: number;
  delta: number;
  side: "buy" | "sell" | "flat";
  volume: number;
};

export type FlowDomLevel = {
  side: "bid" | "ask";
  price: number;
  size: number;
  intensity: number;
};

export type FlowDomFrame = {
  time: number;
  levels: FlowDomLevel[];
  spoofingRisk?: number;
};

export type FlowEventKind = "sweep" | "absorption" | "exhaustion" | "spoof" | "breakout" | "reversion";

export type FlowEvent = {
  kind: FlowEventKind;
  side: "buy" | "sell";
  price: number;
  score: number;
  time: number;
  persistence: number;
  label: string;
};

export type FlowLiquidityZone = {
  price: number;
  side: "bid" | "ask";
  strength: number;
  persistence: number;
  ageMs: number;
  distanceBps: number;
};

export type FlowIntelligenceSnapshot = {
  flowScore: number;
  buyPressure: number;
  sellPressure: number;
  deltaMomentum: number;
  domImbalance: number;
  liquidityBias: number;
  dominantSide: "buy" | "sell" | "neutral";
  spoofRisk: number;
  activeEvent: FlowEvent | null;
  recentEvents: FlowEvent[];
  liquidityZones: FlowLiquidityZone[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTradeWindow(input: {
  tape: FlowTradeTick[];
  fallbackTimeMs: number;
  timeframeMs: number;
}): FlowTradeTick[] {
  const stepMs = Math.max(120, Math.min(1_500, Math.floor(input.timeframeMs / Math.max(8, input.tape.length || 1))));
  return input.tape
    .map((trade, index, array) => {
      const reverseIndex = array.length - index - 1;
      const volume = Math.max(0, toFiniteNumber(trade.volume, Math.abs(toFiniteNumber(trade.delta, 0))));
      const side: FlowTradeTick["side"] = trade.side === "sell" ? "sell" : trade.side === "buy" ? "buy" : "flat";
      const impliedDelta = side === "sell" ? -volume : side === "buy" ? volume : 0;
      return {
        time: toFiniteNumber(trade.time, input.fallbackTimeMs - reverseIndex * stepMs),
        price: Math.max(0, toFiniteNumber(trade.price, 0)),
        delta: toFiniteNumber(trade.delta, impliedDelta),
        side,
        volume,
      };
    })
    .filter((trade) => trade.time > 0 && trade.price > 0 && trade.volume >= 0)
    .sort((left, right) => left.time - right.time);
}

function derivePriceStep(levels: FlowDomLevel[], currentPrice: number): number {
  const prices = [...new Set(
    levels
      .map((level) => toFiniteNumber(level.price, 0))
      .filter((price) => price > 0)
      .sort((left, right) => left - right),
  )];
  const deltas: number[] = [];
  for (let index = 1; index < prices.length; index += 1) {
    const diff = prices[index] - prices[index - 1];
    if (diff > 0) {
      deltas.push(diff);
    }
  }
  if (deltas.length > 0) {
    return deltas.sort((left, right) => left - right)[0];
  }
  return Math.max(currentPrice * 0.00035, currentPrice >= 100 ? 0.5 : currentPrice >= 10 ? 0.05 : 0.005);
}

function buildLiquidityZones(input: {
  frames: FlowDomFrame[];
  currentPrice: number;
  priceStep: number;
}): FlowLiquidityZone[] {
  if (input.frames.length === 0 || !(input.priceStep > 0)) {
    return [];
  }

  const frames = input.frames.slice(-36);
  const now = Math.max(frames[frames.length - 1]?.time || 0, Date.now());
  const firstTime = frames[0]?.time || now;
  const lookbackMs = Math.max(8_000, now - firstTime || 30_000);
  const memory = new Map<string, {
    price: number;
    bidSeen: number;
    askSeen: number;
    score: number;
    seen: number;
    lastTime: number;
  }>();

  frames.forEach((frame, frameIndex) => {
    const frameWeight = 0.62 + (frameIndex / Math.max(1, frames.length - 1)) * 0.38;
    [...frame.levels]
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((left, right) => (Math.max(right.intensity, right.size) - Math.max(left.intensity, left.size)))
      .slice(0, 10)
      .forEach((level) => {
        const bucket = Math.round(level.price / input.priceStep) * input.priceStep;
        const key = `${level.side}:${bucket.toFixed(8)}`;
        const existing = memory.get(key) || {
          price: bucket,
          bidSeen: 0,
          askSeen: 0,
          score: 0,
          seen: 0,
          lastTime: 0,
        };
        const levelScore = Math.log1p(Math.max(1, level.size)) * (0.68 + clamp(level.intensity, 0, 1.6) * 0.32) * frameWeight;
        existing.score += levelScore;
        existing.seen += 1;
        existing.lastTime = Math.max(existing.lastTime, frame.time);
        if (level.side === "bid") {
          existing.bidSeen += 1;
        } else {
          existing.askSeen += 1;
        }
        memory.set(key, existing);
      });
  });

  return [...memory.values()]
    .map((entry) => {
      const persistence = clamp(entry.seen / Math.max(1, frames.length), 0, 1);
      const ageMs = Math.max(0, now - entry.lastTime);
      const recency = Math.exp(-ageMs / Math.max(8_000, lookbackMs * 0.55));
      const scoreStrength = clamp(Math.log1p(entry.score) / 3.2, 0, 1);
      const strength = clamp(scoreStrength * 0.48 + persistence * 0.34 + recency * 0.18, 0, 1);
      const distanceBps = input.currentPrice > 0
        ? Math.abs(entry.price - input.currentPrice) / input.currentPrice * 10_000
        : 0;
      return {
        price: entry.price,
        side: entry.bidSeen >= entry.askSeen ? "bid" : "ask",
        strength,
        persistence,
        ageMs,
        distanceBps,
      } satisfies FlowLiquidityZone;
    })
    .filter((zone) => zone.strength >= 0.2 && zone.distanceBps <= 90)
    .sort((left, right) => {
      const leftScore = left.strength * 0.78 + clamp(1 - left.distanceBps / 90, 0, 1) * 0.22;
      const rightScore = right.strength * 0.78 + clamp(1 - right.distanceBps / 90, 0, 1) * 0.22;
      return rightScore - leftScore;
    })
    .slice(0, 6);
}

function computeDomImbalance(levels: FlowDomLevel[]): number {
  if (levels.length === 0) {
    return 0;
  }
  const topLevels = [...levels]
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((left, right) => (Math.max(right.intensity, right.size) - Math.max(left.intensity, left.size)))
    .slice(0, 12);
  const bidScore = topLevels
    .filter((level) => level.side === "bid")
    .reduce((sum, level) => sum + level.size * (0.7 + clamp(level.intensity, 0, 1.5) * 0.3), 0);
  const askScore = topLevels
    .filter((level) => level.side === "ask")
    .reduce((sum, level) => sum + level.size * (0.7 + clamp(level.intensity, 0, 1.5) * 0.3), 0);
  return clamp((bidScore - askScore) / Math.max(1, bidScore + askScore), -1, 1);
}

function detectFlowEvents(input: {
  trades: FlowTradeTick[];
  currentPrice: number;
  domImbalance: number;
  deltaMomentum: number;
  buyPressure: number;
  sellPressure: number;
  spoofRisk: number;
  liquidityZones: FlowLiquidityZone[];
  domLevels: FlowDomLevel[];
}): FlowEvent[] {
  const events: FlowEvent[] = [];
  const now = input.trades[input.trades.length - 1]?.time || Date.now();
  const dominantTradeSide: "buy" | "sell" = input.buyPressure >= input.sellPressure ? "buy" : "sell";
  const pressureDominance = Math.max(input.buyPressure, input.sellPressure);
  const firstTrade = input.trades[0];
  const lastTrade = input.trades[input.trades.length - 1];
  const priceVelocity = input.currentPrice > 0 && firstTrade && lastTrade
    ? (lastTrade.price - firstTrade.price) / input.currentPrice
    : 0;
  const strongestLevel = [...input.domLevels]
    .filter((level) => level.price > 0 && level.size > 0)
    .sort((left, right) => (right.size * (0.7 + right.intensity * 0.3)) - (left.size * (0.7 + left.intensity * 0.3)))[0];
  const nearestZone = input.liquidityZones[0] || null;

  if (input.spoofRisk >= 0.58 && strongestLevel) {
    events.push({
      kind: "spoof",
      side: strongestLevel.side === "ask" ? "sell" : "buy",
      price: strongestLevel.price,
      score: clamp(input.spoofRisk * 0.78 + (nearestZone?.strength || 0) * 0.12, 0, 1),
      time: now,
      persistence: nearestZone?.persistence || 0,
      label: "spoof pressure",
    });
  }

  if (Math.abs(input.deltaMomentum) >= 0.24 && Math.abs(input.domImbalance) >= 0.16 && Math.sign(input.deltaMomentum) !== Math.sign(input.domImbalance)) {
    const absorbingSide: "buy" | "sell" = input.domImbalance >= 0 ? "buy" : "sell";
    const zone = input.liquidityZones.find((candidate) => candidate.side === (absorbingSide === "buy" ? "bid" : "ask"));
    events.push({
      kind: "absorption",
      side: absorbingSide,
      price: zone?.price || input.currentPrice,
      score: clamp(Math.abs(input.deltaMomentum) * 0.46 + Math.abs(input.domImbalance) * 0.34 + (zone?.strength || 0) * 0.2, 0, 1),
      time: now,
      persistence: zone?.persistence || 0,
      label: `${absorbingSide} absorption`,
    });
  }

  if (Math.abs(input.deltaMomentum) >= 0.38 && pressureDominance >= 0.64 && Math.sign(input.deltaMomentum) === Math.sign(priceVelocity || input.deltaMomentum)) {
    events.push({
      kind: "sweep",
      side: dominantTradeSide,
      price: input.currentPrice,
      score: clamp(Math.abs(input.deltaMomentum) * 0.54 + pressureDominance * 0.28 + Math.abs(priceVelocity) * 260, 0, 1),
      time: now,
      persistence: nearestZone?.persistence || 0,
      label: `${dominantTradeSide} sweep`,
    });
  }

  if (Math.abs(input.deltaMomentum) >= 0.22 && Math.abs(priceVelocity) <= 0.00018) {
    events.push({
      kind: "exhaustion",
      side: dominantTradeSide,
      price: input.currentPrice,
      score: clamp(Math.abs(input.deltaMomentum) * 0.58 + (1 - Math.min(1, Math.abs(priceVelocity) * 3000)) * 0.22 + (nearestZone?.strength || 0) * 0.2, 0, 1),
      time: now,
      persistence: nearestZone?.persistence || 0,
      label: `${dominantTradeSide} exhaustion`,
    });
  }

  if (nearestZone && nearestZone.distanceBps <= 12 && Math.abs(input.deltaMomentum) >= 0.2) {
    if (nearestZone.side === "ask" && dominantTradeSide === "buy" && priceVelocity > 0) {
      events.push({
        kind: "breakout",
        side: "buy",
        price: nearestZone.price,
        score: clamp(Math.abs(input.deltaMomentum) * 0.42 + nearestZone.strength * 0.38 + Math.abs(priceVelocity) * 180, 0, 1),
        time: now,
        persistence: nearestZone.persistence,
        label: "ask breakout test",
      });
    }
    if (nearestZone.side === "bid" && dominantTradeSide === "sell" && priceVelocity < 0) {
      events.push({
        kind: "breakout",
        side: "sell",
        price: nearestZone.price,
        score: clamp(Math.abs(input.deltaMomentum) * 0.42 + nearestZone.strength * 0.38 + Math.abs(priceVelocity) * 180, 0, 1),
        time: now,
        persistence: nearestZone.persistence,
        label: "bid breakdown test",
      });
    }
    if (nearestZone.side === "bid" && dominantTradeSide === "sell" && priceVelocity >= -0.00008) {
      events.push({
        kind: "reversion",
        side: "buy",
        price: nearestZone.price,
        score: clamp(nearestZone.strength * 0.44 + nearestZone.persistence * 0.22 + Math.abs(input.domImbalance) * 0.18 + Math.abs(input.deltaMomentum) * 0.16, 0, 1),
        time: now,
        persistence: nearestZone.persistence,
        label: "bid reversion", 
      });
    }
    if (nearestZone.side === "ask" && dominantTradeSide === "buy" && priceVelocity <= 0.00008) {
      events.push({
        kind: "reversion",
        side: "sell",
        price: nearestZone.price,
        score: clamp(nearestZone.strength * 0.44 + nearestZone.persistence * 0.22 + Math.abs(input.domImbalance) * 0.18 + Math.abs(input.deltaMomentum) * 0.16, 0, 1),
        time: now,
        persistence: nearestZone.persistence,
        label: "ask reversion",
      });
    }
  }

  return events
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
}

export function computeFlowIntelligence(input: {
  tape: FlowTradeTick[];
  domLevels: FlowDomLevel[];
  domHistory: FlowDomFrame[];
  currentPrice: number;
  timeframeMs: number;
  fallbackTimeMs: number;
  spoofRisk?: number;
}): FlowIntelligenceSnapshot | null {
  const trades = normalizeTradeWindow({
    tape: input.tape,
    fallbackTimeMs: input.fallbackTimeMs,
    timeframeMs: input.timeframeMs,
  }).slice(-36);
  const domLevels = input.domLevels.filter((level) => level.price > 0 && level.size > 0);
  const domHistory = input.domHistory.filter((frame) => frame.time > 0 && frame.levels.length > 0).slice(-48);
  if (trades.length === 0 && domLevels.length === 0 && domHistory.length === 0) {
    return null;
  }

  const totalVolume = trades.reduce((sum, trade) => sum + Math.max(0, trade.volume), 0);
  const buyVolume = trades.reduce((sum, trade) => sum + (trade.side === "buy" ? Math.max(0, trade.volume) : 0), 0);
  const sellVolume = trades.reduce((sum, trade) => sum + (trade.side === "sell" ? Math.max(0, trade.volume) : 0), 0);
  const buyPressure = totalVolume > 0 ? buyVolume / totalVolume : 0.5;
  const sellPressure = totalVolume > 0 ? sellVolume / totalVolume : 0.5;
  const weightedDelta = trades.reduce((sum, trade, index, array) => {
    const sign = trade.side === "sell" ? -1 : trade.side === "buy" ? 1 : Math.sign(trade.delta);
    const weight = 0.64 + ((index + 1) / Math.max(1, array.length)) * 0.36;
    return sum + sign * Math.sqrt(Math.max(1, trade.volume || Math.abs(trade.delta) || 1)) * weight;
  }, 0);
  const deltaMomentum = clamp(Math.tanh(weightedDelta / Math.max(6, Math.sqrt(totalVolume + 1) * 1.9)), -1, 1);
  const currentPrice = input.currentPrice > 0
    ? input.currentPrice
    : trades[trades.length - 1]?.price || domLevels[0]?.price || 0;
  const priceStep = derivePriceStep(domLevels.length > 0 ? domLevels : domHistory.flatMap((frame) => frame.levels), currentPrice || 1);
  const liquidityZones = buildLiquidityZones({
    frames: domHistory.length > 0 ? domHistory : [{ time: input.fallbackTimeMs, levels: domLevels }],
    currentPrice,
    priceStep,
  });
  const domImbalance = computeDomImbalance(domLevels.length > 0 ? domLevels : (domHistory[domHistory.length - 1]?.levels || []));
  const bidStrength = liquidityZones.filter((zone) => zone.side === "bid").reduce((sum, zone) => sum + zone.strength * (0.7 + zone.persistence * 0.3), 0);
  const askStrength = liquidityZones.filter((zone) => zone.side === "ask").reduce((sum, zone) => sum + zone.strength * (0.7 + zone.persistence * 0.3), 0);
  const liquidityBias = clamp((bidStrength - askStrength) / Math.max(0.0000001, bidStrength + askStrength), -1, 1);
  const spoofRisk = clamp(Math.max(input.spoofRisk || 0, domHistory[domHistory.length - 1]?.spoofingRisk || 0), 0, 1);
  const recentEvents = detectFlowEvents({
    trades,
    currentPrice,
    domImbalance,
    deltaMomentum,
    buyPressure,
    sellPressure,
    spoofRisk,
    liquidityZones,
    domLevels: domLevels.length > 0 ? domLevels : (domHistory[domHistory.length - 1]?.levels || []),
  });
  const activeEvent = recentEvents[0] || null;
  const directionalScore = deltaMomentum * 0.44 + domImbalance * 0.31 + liquidityBias * 0.25;
  const dominantSide = directionalScore > 0.08 ? "buy" : directionalScore < -0.08 ? "sell" : "neutral";
  const flowScore = clamp(
    Math.abs(deltaMomentum) * 0.28
      + Math.abs(domImbalance) * 0.18
      + Math.abs(liquidityBias) * 0.18
      + (activeEvent?.score || 0) * 0.36,
    0,
    1,
  );

  return {
    flowScore,
    buyPressure,
    sellPressure,
    deltaMomentum,
    domImbalance,
    liquidityBias,
    dominantSide,
    spoofRisk,
    activeEvent,
    recentEvents,
    liquidityZones,
  };
}