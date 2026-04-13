import { detectStructure, type StructureCandle, type StructureSnapshot } from "./structureEngine";

export type RegimeState = "BULL" | "BEAR" | "RANGE" | "CONFLICT";
export type RegimeBias = "long" | "short" | "neutral";
export type RegimeHorizonKey = "trend" | "bias" | "setup" | "trigger";

export type RegimeHorizonSnapshot = {
  key: RegimeHorizonKey;
  label: string;
  lookback: number;
  structure: StructureSnapshot;
};

export type RegimeSnapshot = {
  state: RegimeState;
  aligned: boolean;
  alignmentStrength: number;
  bias: RegimeBias;
  reason: string;
  horizons: RegimeHorizonSnapshot[];
};

type HorizonConfig = {
  key: RegimeHorizonKey;
  label: string;
  lookback: number;
  pivotWindow: number;
  weight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mapStructureToBias(structure: StructureSnapshot): RegimeBias {
  if (structure.state === "trend-up") {
    return "long";
  }
  if (structure.state === "trend-down") {
    return "short";
  }
  return "neutral";
}

function inferTransitionBias(structure: StructureSnapshot): RegimeBias {
  const bullishTags = structure.sequence.filter((tag) => tag === "HH" || tag === "HL").length;
  const bearishTags = structure.sequence.filter((tag) => tag === "LH" || tag === "LL").length;
  if (bullishTags >= 2 && bearishTags === 0 && structure.impulseScore >= 0.45) {
    return "long";
  }
  if (bearishTags >= 2 && bullishTags === 0 && structure.impulseScore >= 0.45) {
    return "short";
  }
  return "neutral";
}

function resolveHorizonBias(structure: StructureSnapshot): RegimeBias {
  if (structure.state === "range") {
    return "neutral";
  }
  const directionalBias = mapStructureToBias(structure);
  if (directionalBias !== "neutral") {
    return directionalBias;
  }
  return inferTransitionBias(structure);
}

function buildHorizonConfigs(totalCount: number): HorizonConfig[] {
  const compactSeries = totalCount < 20;
  return [
    {
      key: "trend",
      label: "Trend",
      lookback: compactSeries ? totalCount : Math.min(totalCount, Math.max(28, totalCount)),
      pivotWindow: compactSeries ? 1 : 2,
      weight: 0.36,
    },
    {
      key: "bias",
      label: "Bias",
      lookback: compactSeries ? Math.min(totalCount, Math.max(10, Math.floor(totalCount * 0.85))) : Math.min(totalCount, Math.max(20, Math.floor(totalCount * 0.72))),
      pivotWindow: compactSeries ? 1 : 2,
      weight: 0.28,
    },
    {
      key: "setup",
      label: "Setup",
      lookback: compactSeries ? Math.min(totalCount, Math.max(8, Math.floor(totalCount * 0.6))) : Math.min(totalCount, Math.max(14, Math.floor(totalCount * 0.48))),
      pivotWindow: 1,
      weight: 0.22,
    },
    {
      key: "trigger",
      label: "Trigger",
      lookback: compactSeries ? Math.min(totalCount, Math.max(6, Math.floor(totalCount * 0.4))) : Math.min(totalCount, Math.max(10, Math.floor(totalCount * 0.3))),
      pivotWindow: 1,
      weight: 0.14,
    },
  ];
}

export function buildRegimeHorizons(candles: StructureCandle[]): RegimeHorizonSnapshot[] {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  return buildHorizonConfigs(candles.length).map((config) => ({
    key: config.key,
    label: config.label,
    lookback: config.lookback,
    structure: detectStructure(candles.slice(-config.lookback), { pivotWindow: config.pivotWindow }),
  }));
}

export function resolveRegime(input: { horizons: RegimeHorizonSnapshot[] }): RegimeSnapshot {
  const horizons = input.horizons;
  if (!Array.isArray(horizons) || horizons.length === 0) {
    return {
      state: "CONFLICT",
      aligned: false,
      alignmentStrength: 0,
      bias: "neutral",
      reason: "No horizons available",
      horizons: [],
    };
  }

  const configs = buildHorizonConfigs(horizons.length * 24);
  const weights = new Map(configs.map((config) => [config.key, config.weight]));
  let bullishWeight = 0;
  let bearishWeight = 0;
  let rangeWeight = 0;
  let confidenceWeight = 0;

  for (const horizon of horizons) {
    const weight = weights.get(horizon.key) ?? 0.25;
    const horizonBias = resolveHorizonBias(horizon.structure);
    confidenceWeight += horizon.structure.confidence * weight;
    if (horizonBias === "long") {
      bullishWeight += weight;
    } else if (horizonBias === "short") {
      bearishWeight += weight;
    } else if (horizon.structure.state === "range") {
      rangeWeight += weight;
    }
  }

  const totalDirectionalWeight = bullishWeight + bearishWeight;
  const directionalGap = Math.abs(bullishWeight - bearishWeight);
  const dominantBias: RegimeBias = bullishWeight > bearishWeight ? "long" : bearishWeight > bullishWeight ? "short" : "neutral";
  const triggerBias = resolveHorizonBias(horizons.find((horizon) => horizon.key === "trigger")?.structure ?? horizons[horizons.length - 1].structure);
  const setupBias = resolveHorizonBias(horizons.find((horizon) => horizon.key === "setup")?.structure ?? horizons[Math.max(0, horizons.length - 2)].structure);
  const aligned = dominantBias !== "neutral" && triggerBias === dominantBias && setupBias === dominantBias;
  const weightedConfidence = clamp(confidenceWeight, 0, 1);
  const alignmentStrength = clamp(
    weightedConfidence * 0.48
      + clamp(directionalGap, 0, 1) * 0.32
      + (aligned ? 0.2 : 0),
    0,
    1,
  );

  let state: RegimeState = "CONFLICT";
  if (rangeWeight >= 0.5 && totalDirectionalWeight <= 0.45) {
    state = "RANGE";
  } else if (bullishWeight >= 0.52 && bearishWeight <= 0.22) {
    state = "BULL";
  } else if (bearishWeight >= 0.52 && bullishWeight <= 0.22) {
    state = "BEAR";
  }

  let reason = "Mixed horizon signals";
  if (state === "BULL") {
    reason = aligned
      ? `Bull regime aligned ${Math.round(alignmentStrength * 100)}%`
      : `Bull regime dominant but trigger/setup still catching up`;
  } else if (state === "BEAR") {
    reason = aligned
      ? `Bear regime aligned ${Math.round(alignmentStrength * 100)}%`
      : `Bear regime dominant but trigger/setup still catching up`;
  } else if (state === "RANGE") {
    reason = `Range regime across ${Math.round(rangeWeight * 100)}% of weighted horizons`;
  }

  return {
    state,
    aligned,
    alignmentStrength,
    bias: state === "BULL" ? "long" : state === "BEAR" ? "short" : "neutral",
    reason,
    horizons,
  };
}

export function buildRegimeSnapshot(candles: StructureCandle[]): RegimeSnapshot {
  return resolveRegime({ horizons: buildRegimeHorizons(candles) });
}