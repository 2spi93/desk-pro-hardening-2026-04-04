import type { PreCandleFilterOptions, PreCandleFilterTelemetry, PreCandleTick } from "./smartChartTypes";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveReferenceTickSize<T extends PreCandleTick>(ticks: T[], preferredTickSize?: number): number {
  if (Number.isFinite(preferredTickSize) && Number(preferredTickSize) > 0) {
    return Number(preferredTickSize);
  }

  let minPositiveDelta = Number.POSITIVE_INFINITY;
  for (let index = 1; index < ticks.length; index += 1) {
    const delta = Math.abs(Number(ticks[index].price) - Number(ticks[index - 1].price));
    if (delta > 0 && delta < minPositiveDelta) {
      minPositiveDelta = delta;
    }
  }

  return Number.isFinite(minPositiveDelta) ? minPositiveDelta : 0;
}

function resolveTickDelta<T extends PreCandleTick>(ticks: T[], index: number): number {
  const current = ticks[index];
  if (!current) {
    return 0;
  }
  if (Number.isFinite(current.deltaPrice)) {
    return Number(current.deltaPrice);
  }
  const previous = ticks[index - 1];
  if (!previous) {
    return 0;
  }
  return Number(current.price) - Number(previous.price);
}

function isAlternatingBidAskPattern<T extends PreCandleTick>(ticks: T[], index: number, referenceTickSize: number): boolean {
  if (index < 2 || referenceTickSize <= 0) {
    return false;
  }

  const current = ticks[index];
  const previous = ticks[index - 1];
  const previousTwo = ticks[index - 2];
  if (!current || !previous || !previousTwo) {
    return false;
  }

  if (current.kind === "spoof" || previous.kind === "spoof" || previousTwo.kind === "spoof") {
    return false;
  }

  if (!current.side || !previous.side || !previousTwo.side) {
    return false;
  }

  const alternatingSides = current.side !== previous.side && previous.side !== previousTwo.side && current.side === previousTwo.side;
  if (!alternatingSides) {
    return false;
  }

  const deltaOne = resolveTickDelta(ticks, index - 1);
  const deltaTwo = resolveTickDelta(ticks, index);
  if (deltaOne === 0 || deltaTwo === 0 || Math.sign(deltaOne) !== -Math.sign(deltaTwo)) {
    return false;
  }

  const confinedBand = Math.abs(Number(current.price) - Number(previousTwo.price)) <= referenceTickSize * 1.1;
  const maxVolume = Math.max(Number(current.volume) || 0, Number(previous.volume) || 0, Number(previousTwo.volume) || 0);
  const avgIntensity = (Number(current.intensity) || 0 + Number(previous.intensity) || 0 + Number(previousTwo.intensity) || 0) / 3;
  return confinedBand && maxVolume <= 25 && avgIntensity < 0.72;
}

export function preFilterTicks<T extends PreCandleTick>(
  ticks: T[],
  options: PreCandleFilterOptions = {},
): { filtered: T[]; telemetry: PreCandleFilterTelemetry } {
  if (!Array.isArray(ticks) || ticks.length === 0) {
    return {
      filtered: [],
      telemetry: {
        inputCount: 0,
        keptCount: 0,
        droppedSmallMoveCount: 0,
        droppedAlternatingCount: 0,
        droppedRatio: 0,
        referenceTickSize: 0,
      },
    };
  }

  const minRelativeMoveRatio = clamp(Number(options.minRelativeMoveRatio) || 0.5, 0.1, 2);
  const alternatingLookback = Math.max(2, Math.floor(options.alternatingLookback || 3));
  const referenceTickSize = resolveReferenceTickSize(ticks, options.minPriceIncrement);
  const filtered: T[] = [];
  let droppedSmallMoveCount = 0;
  let droppedAlternatingCount = 0;

  for (let index = 0; index < ticks.length; index += 1) {
    const current = ticks[index];
    if (!current || !Number.isFinite(current.time) || !Number.isFinite(current.price)) {
      continue;
    }

    const delta = Math.abs(resolveTickDelta(ticks, index));
    const isLowValueTrade = (current.kind ?? "trade") !== "spoof"
      && referenceTickSize > 0
      && index > 0
      && delta < referenceTickSize * minRelativeMoveRatio;
    if (isLowValueTrade) {
      droppedSmallMoveCount += 1;
      continue;
    }

    const alternating = alternatingLookback >= 3 && isAlternatingBidAskPattern(ticks, index, referenceTickSize);
    if (alternating) {
      droppedAlternatingCount += 1;
      continue;
    }

    filtered.push(current);
  }

  const droppedCount = Math.max(0, ticks.length - filtered.length);
  return {
    filtered,
    telemetry: {
      inputCount: ticks.length,
      keptCount: filtered.length,
      droppedSmallMoveCount,
      droppedAlternatingCount,
      droppedRatio: ticks.length > 0 ? droppedCount / ticks.length : 0,
      referenceTickSize,
    },
  };
}