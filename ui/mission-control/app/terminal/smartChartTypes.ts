export type SmartNoiseClass = "noise" | "weak" | "valid";

export type SmartCandleRole = "noise" | "context" | "trigger";

export type SmartCandleMetrics = {
  range: number;
  body: number;
  bodyRatio: number;
  directionalClosePosition: number;
  volumeRatio: number;
  volumeScore: number;
  wickToBodyRatio: number;
  noiseClass: SmartNoiseClass;
  qualityScore: number;
  role: SmartCandleRole;
  wickOpacityPenalty: number;
  adaptiveThreshold: number;
  microstructurePenalty: number;
};

export type PreCandleTickSide = "buy" | "sell";

export type PreCandleTickKind = "trade" | "spoof" | "quote" | "unknown";

export type PreCandleTick = {
  time: number;
  price: number;
  volume?: number;
  side?: PreCandleTickSide;
  kind?: PreCandleTickKind;
  intensity?: number;
  deltaPrice?: number;
};

export type PreCandleFilterOptions = {
  minPriceIncrement?: number;
  minRelativeMoveRatio?: number;
  alternatingLookback?: number;
};

export type PreCandleFilterTelemetry = {
  inputCount: number;
  keptCount: number;
  droppedSmallMoveCount: number;
  droppedAlternatingCount: number;
  droppedRatio: number;
  referenceTickSize: number;
};