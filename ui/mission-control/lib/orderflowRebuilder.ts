import type { OrderflowRuntimeSnapshot } from "./orderflowRuntimeEngine";

type JsonRecord = Record<string, unknown>;

type RebuilderBar = {
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
};

export type RebuiltOrderflowSnapshot = {
  source: "runtime" | "synthetic" | "hybrid";
  imbalance: number;
  delta: number;
  cumulativeDelta: number;
  depthImbalance: number;
  volume: number;
  spreadBps: number;
  liquidityScore: number;
  domDensity: number;
  absorptionProb: number;
  orderflowQuality: number;
  spoofingRisk: number;
  recentMovePct: number;
  priceEfficiency: number;
  wickBias: number;
  wickNoise: number;
  microNoiseScore: number;
  reliability: number;
  reasons: string[];
};

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

function sanitizeBars(bars: Array<RebuilderBar | JsonRecord> | null | undefined): Required<RebuilderBar>[] {
  if (!Array.isArray(bars)) {
    return [];
  }
  return bars
    .map((item) => {
      const record = asRecord(item);
      const open = toNumber(record.o ?? record.open, Number.NaN);
      const high = toNumber(record.h ?? record.high, Number.NaN);
      const low = toNumber(record.l ?? record.low, Number.NaN);
      const close = toNumber(record.c ?? record.close, Number.NaN);
      const volume = Math.max(0, toNumber(record.v ?? record.volume, 0));
      if (![open, high, low, close].every(Number.isFinite)) {
        return null;
      }
      return {
        o: open,
        h: Math.max(high, open, close),
        l: Math.min(low, open, close),
        c: close,
        v: volume,
      };
    })
    .filter((item): item is Required<RebuilderBar> => Boolean(item));
}

export function rebuildSyntheticOrderflow(input: {
  runtime?: OrderflowRuntimeSnapshot | null;
  marketMicro?: Record<string, unknown> | null;
  bars?: Array<RebuilderBar | JsonRecord> | null;
}): RebuiltOrderflowSnapshot {
  const runtime = input.runtime || null;
  const latestReplayFrame = runtime && runtime.replayFrames.length > 0
    ? runtime.replayFrames[runtime.replayFrames.length - 1]
    : null;
  const runtimeFootprint = runtime?.footprint || latestReplayFrame?.footprint || null;
  const runtimeDom = runtime?.dom || latestReplayFrame?.dom || null;
  const marketMicro = asRecord(input.marketMicro);
  const bars = sanitizeBars(input.bars).slice(-10);
  const reasons: string[] = [];

  if (!runtimeFootprint) {
    reasons.push("runtime_footprint_missing");
  }
  if (!runtimeDom) {
    reasons.push("runtime_dom_missing");
  }
  if (bars.length < 3) {
    reasons.push("insufficient_bar_context");
  }

  let syntheticSignedVolume = 0;
  let syntheticVolume = 0;
  let cumulativeSyntheticDelta = 0;
  const priceEfficiencySeries: number[] = [];
  const wickNoiseSeries: number[] = [];
  const wickBiasSeries: number[] = [];
  const directionSeries: number[] = [];

  bars.forEach((bar, index) => {
    const range = Math.max(bar.h - bar.l, Math.abs(bar.c) * 1e-6, 1e-6);
    const body = Math.abs(bar.c - bar.o);
    const direction = bar.c > bar.o ? 1 : bar.c < bar.o ? -1 : 0;
    const upperWick = Math.max(0, bar.h - Math.max(bar.o, bar.c));
    const lowerWick = Math.max(0, Math.min(bar.o, bar.c) - bar.l);
    const priceEfficiency = clamp(body / range, 0, 1);
    const wickNoise = clamp((upperWick + lowerWick) / range, 0, 1);
    const wickBias = clamp((lowerWick - upperWick) / range, -1, 1);
    const proxyVolume = Math.max(1, bar.v || Math.round(range * 1000));
    const weightedFlow = proxyVolume * (direction * (0.65 + priceEfficiency * 0.35) + wickBias * 0.2);

    syntheticSignedVolume += weightedFlow;
    syntheticVolume += proxyVolume;
    cumulativeSyntheticDelta += weightedFlow * (1 + index * 0.04);
    priceEfficiencySeries.push(priceEfficiency);
    wickNoiseSeries.push(wickNoise);
    wickBiasSeries.push(wickBias);
    directionSeries.push(direction);
  });

  let alternationCount = 0;
  for (let index = 1; index < directionSeries.length; index += 1) {
    if (directionSeries[index] !== 0 && directionSeries[index - 1] !== 0 && directionSeries[index] !== directionSeries[index - 1]) {
      alternationCount += 1;
    }
  }

  const syntheticImbalance = syntheticVolume > 0 ? clamp(syntheticSignedVolume / syntheticVolume, -1, 1) : 0;
  const syntheticDepthImbalance = clamp(average(wickBiasSeries) * 0.6 + syntheticImbalance * 0.4, -1, 1);
  const recentMovePct = bars.length >= 2 && bars[0].c > 0
    ? (bars[bars.length - 1].c - bars[0].c) / bars[0].c
    : 0;
  const priceEfficiency = average(priceEfficiencySeries);
  const wickNoise = average(wickNoiseSeries);
  const alternationRate = directionSeries.length > 1 ? alternationCount / (directionSeries.length - 1) : 0;
  const syntheticAbsorption = clamp(
    (1 - Math.min(1, Math.abs(syntheticImbalance))) * 0.34
      + clamp((0.0032 - Math.abs(recentMovePct)) / 0.0032, 0, 1) * 0.26
      + priceEfficiency * 0.12
      + (1 - wickNoise) * 0.16
      + clamp((0.45 - alternationRate) / 0.45, 0, 1) * 0.12,
    0,
    1,
  );
  const syntheticSpoofingRisk = clamp(
    Math.max(0, average(wickBiasSeries.map((value) => Math.abs(value))) - 0.18) * 0.4
      + alternationRate * 0.28
      + (1 - priceEfficiency) * 0.18,
    0,
    1,
  );

  const runtimeImbalance = runtimeFootprint ? clamp(toNumber(runtimeFootprint.imbalance, 0), -1, 1) : Number.NaN;
  const runtimeDelta = runtimeFootprint ? toNumber(runtimeFootprint.delta, 0) : Number.NaN;
  const runtimeCumulativeDelta = runtimeFootprint ? toNumber(runtimeFootprint.cumulativeDelta, 0) : Number.NaN;
  const runtimeDepthImbalance = runtimeDom ? clamp(toNumber(runtimeDom.depthBalance, 0), -1, 1) : Number.NaN;
  const runtimeVolume = runtimeFootprint ? Math.max(0, toNumber(runtimeFootprint.volume, 0)) : Number.NaN;
  const runtimeAbsorption = runtimeFootprint ? clamp(Math.max(toNumber(runtimeFootprint.absorptionProb, 0), toNumber(runtimeFootprint.mlAbsorptionScore, 0)), 0, 1) : Number.NaN;
  const runtimeLiquidityScore = runtimeDom ? clamp(toNumber(runtimeDom.liquidityScore, 0), 0, 1) : Number.NaN;
  const runtimeDomDensity = runtimeDom ? clamp(toNumber(runtimeDom.domDensity, 0), 0, 1) : Number.NaN;
  const runtimeSpoofingRisk = runtimeDom ? clamp(toNumber(runtimeDom.spoofingRisk, 0), 0, 1) : Number.NaN;
  const runtimeSpreadBps = runtimeDom ? Math.max(0, toNumber(runtimeDom.spreadBps, 0)) : Number.NaN;

  const marketImbalance = clamp(toNumber(marketMicro.flow_imbalance ?? marketMicro.imbalance, Number.NaN), -1, 1);
  const marketDelta = toNumber(marketMicro.cvd_delta ?? marketMicro.delta, Number.NaN);
  const marketCumulativeDelta = toNumber(marketMicro.cvd, Number.NaN);
  const marketDepthImbalance = clamp(toNumber(marketMicro.depth_imbalance ?? marketMicro.depthImbalance, Number.NaN), -1, 1);
  const marketVolume = Math.max(0, toNumber(marketMicro.buy_volume, 0) + toNumber(marketMicro.sell_volume, 0));
  const marketSpreadBps = Math.max(0, toNumber(marketMicro.spread_bps, Number.NaN));

  const primaryPresence = [runtimeFootprint ? 1 : 0, runtimeDom ? 1 : 0, Number.isFinite(marketImbalance) ? 1 : 0, bars.length >= 3 ? 1 : 0];
  const presenceScore = average(primaryPresence);
  const blendWeight = runtimeFootprint || runtimeDom ? 0.68 : Number.isFinite(marketImbalance) || Number.isFinite(marketDepthImbalance) ? 0.42 : 0;

  const imbalanceBase = Number.isFinite(runtimeImbalance)
    ? runtimeImbalance
    : Number.isFinite(marketImbalance)
      ? marketImbalance
      : syntheticImbalance;
  const depthBase = Number.isFinite(runtimeDepthImbalance)
    ? runtimeDepthImbalance
    : Number.isFinite(marketDepthImbalance)
      ? marketDepthImbalance
      : syntheticDepthImbalance;

  const imbalance = clamp(imbalanceBase * Math.max(blendWeight, 0.35) + syntheticImbalance * (1 - Math.max(blendWeight, 0.35)), -1, 1);
  const depthImbalance = clamp(depthBase * Math.max(blendWeight, 0.35) + syntheticDepthImbalance * (1 - Math.max(blendWeight, 0.35)), -1, 1);
  const delta = Number.isFinite(runtimeDelta)
    ? runtimeDelta
    : Number.isFinite(marketDelta)
      ? marketDelta
      : syntheticSignedVolume;
  const cumulativeDelta = Number.isFinite(runtimeCumulativeDelta)
    ? runtimeCumulativeDelta
    : Number.isFinite(marketCumulativeDelta)
      ? marketCumulativeDelta
      : cumulativeSyntheticDelta;
  const volume = Number.isFinite(runtimeVolume)
    ? runtimeVolume
    : marketVolume > 0
      ? marketVolume
      : syntheticVolume;
  const spreadBps = Number.isFinite(runtimeSpreadBps)
    ? runtimeSpreadBps
    : Number.isFinite(marketSpreadBps)
      ? marketSpreadBps
      : 0;
  const liquidityScore = clamp(
    (Number.isFinite(runtimeLiquidityScore) ? runtimeLiquidityScore : 0.45) * 0.52
      + clamp(volume > 0 ? Math.log1p(volume) / Math.log(5000) : 0, 0, 1) * 0.18
      + (1 - clamp(spreadBps / 18, 0, 1)) * 0.14
      + priceEfficiency * 0.08
      + (1 - wickNoise) * 0.08,
    0,
    1,
  );
  const domDensity = clamp(
    (Number.isFinite(runtimeDomDensity) ? runtimeDomDensity : 0.4) * 0.72
      + (1 - wickNoise) * 0.16
      + clamp((0.35 - Math.abs(recentMovePct)) / 0.35, 0, 1) * 0.12,
    0,
    1,
  );
  const absorptionProb = clamp(
    (Number.isFinite(runtimeAbsorption) ? runtimeAbsorption : syntheticAbsorption) * Math.max(blendWeight, 0.35)
      + syntheticAbsorption * (1 - Math.max(blendWeight, 0.35)),
    0,
    1,
  );
  const spoofingRisk = clamp(
    (Number.isFinite(runtimeSpoofingRisk) ? runtimeSpoofingRisk : syntheticSpoofingRisk) * Math.max(blendWeight, 0.4)
      + syntheticSpoofingRisk * (1 - Math.max(blendWeight, 0.4)),
    0,
    1,
  );
  const microNoiseScore = clamp(
    wickNoise * 0.42
      + alternationRate * 0.22
      + (1 - priceEfficiency) * 0.18
      + clamp(spreadBps / 22, 0, 1) * 0.08
      + clamp((0.2 - Math.min(volume, syntheticVolume) / Math.max(volume, syntheticVolume, 1)) * 2, 0, 1) * 0.1,
    0,
    1,
  );
  const reliability = clamp(
    presenceScore * 0.45
      + liquidityScore * 0.18
      + domDensity * 0.12
      + absorptionProb * 0.1
      + priceEfficiency * 0.08
      + (1 - microNoiseScore) * 0.07,
    0,
    1,
  );
  const orderflowQuality = clamp(
    Math.abs(imbalance) * 0.24
      + absorptionProb * 0.18
      + liquidityScore * 0.18
      + domDensity * 0.12
      + reliability * 0.16
      + (1 - microNoiseScore) * 0.12,
    0,
    1,
  );

  if (spreadBps <= 0) {
    reasons.push("spread_unknown");
  }
  if (volume <= 0) {
    reasons.push("volume_proxy_only");
  }
  if (microNoiseScore >= 0.68) {
    reasons.push("micro_noise_filter");
  }
  if (reliability < 0.4) {
    reasons.push("synthetic_orderflow_low_confidence");
  }

  const source = runtimeFootprint && runtimeDom
    ? reasons.length === 0 || presenceScore >= 0.75
      ? "runtime"
      : "hybrid"
    : runtimeFootprint || runtimeDom
      ? "hybrid"
      : "synthetic";

  return {
    source,
    imbalance,
    delta,
    cumulativeDelta,
    depthImbalance,
    volume,
    spreadBps,
    liquidityScore,
    domDensity,
    absorptionProb,
    orderflowQuality,
    spoofingRisk,
    recentMovePct,
    priceEfficiency,
    wickBias: average(wickBiasSeries),
    wickNoise,
    microNoiseScore,
    reliability,
    reasons,
  };
}

export function applyMicroNoiseAdjustment(baseScore: number, snapshot: Pick<RebuiltOrderflowSnapshot, "microNoiseScore" | "reliability">): number {
  const penalty = clamp(snapshot.microNoiseScore * 0.38 + (1 - snapshot.reliability) * 0.16, 0, 0.62);
  return clamp(baseScore * (1 - penalty), 0.05, 1);
}

export function adaptSwarmConfidence(confidence: number, snapshot: Pick<RebuiltOrderflowSnapshot, "microNoiseScore" | "reliability">): number {
  const value = clamp(confidence, 0, 1);
  return clamp(value * (0.58 + snapshot.reliability * 0.42) * (1 - snapshot.microNoiseScore * 0.28), 0, 1);
}