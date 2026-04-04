import type { ChartSnapPriority } from "./userUiPrefs";

export type ChartOrderLineKeyLike = "entry" | "sl" | "tp";
export type ChartSnapFamilyLike = "execution" | "vwap" | "liquidity" | "manual";
export type ChartOrderTicketLike = {
  side: "buy" | "sell";
  preset: "scalp" | "swing" | "low-risk" | "custom";
  entry: number;
  sl: number;
  tp: number;
  oco: boolean;
  active: boolean;
};

type CandleLike = { close: number; high: number; low: number };
type LiquidityZoneLike = { level: number; label: string };
type CrosshairLike = { price: number } | null;
type SnapCandidate = { price: number; label: string };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function getPriceStepDecimals(step: number): number {
  if (!Number.isFinite(step) || step >= 1) {
    return 0;
  }
  const serialized = step.toString();
  if (serialized.includes("e-")) {
    const exponent = Number(serialized.split("e-")[1] || 0);
    return Number.isFinite(exponent) ? exponent : 0;
  }
  const fraction = serialized.split(".")[1];
  return fraction ? fraction.length : 0;
}

export function inferChartPriceStep(symbol: string, referencePrice: number): number {
  const normalizedSymbol = symbol.toUpperCase();
  if (normalizedSymbol.includes("JPY")) {
    return 0.01;
  }
  if (referencePrice >= 50000) {
    return 5;
  }
  if (referencePrice >= 5000) {
    return 1;
  }
  if (referencePrice >= 500) {
    return 0.1;
  }
  if (referencePrice >= 50) {
    return 0.01;
  }
  if (referencePrice >= 5) {
    return 0.001;
  }
  if (referencePrice >= 0.5) {
    return 0.0001;
  }
  return 0.00001;
}

export function quantizePriceToStep(price: number, step: number): number {
  const safeStep = Math.max(0.00000001, step);
  const decimals = getPriceStepDecimals(safeStep);
  return Number((Math.round(price / safeStep) * safeStep).toFixed(decimals));
}

export function computeChartRoundMagnetStep(chartPriceStep: number): number {
  return Math.max(chartPriceStep, chartPriceStep >= 1 ? chartPriceStep * 10 : chartPriceStep * 50);
}

export function computeChartSnapThreshold(chartPriceStep: number, chartPriceRangeMin: number, chartPriceRangeMax: number): number {
  return Math.max(chartPriceStep * 4, (chartPriceRangeMax - chartPriceRangeMin) * 0.005);
}

export function resolveSnappedChartOrderPrice({
  rawPrice,
  line,
  current,
  chartPriceRangeMin,
  chartPriceRangeMax,
  chartPriceStep,
  chartPriceDigits,
  chartSnapEnabled,
  chartRoundMagnetStep,
  chartMode,
  chartCandles,
  showVwap,
  dayVwap,
  weekVwap,
  monthVwap,
  showLiquidity,
  liquidityZones,
  crosshair,
  chartSnapPriority,
  chartSnapThreshold,
  chartAtrLocalPct,
}: {
  rawPrice: number;
  line: ChartOrderLineKeyLike;
  current: ChartOrderTicketLike;
  chartPriceRangeMin: number;
  chartPriceRangeMax: number;
  chartPriceStep: number;
  chartPriceDigits: number;
  chartSnapEnabled: boolean;
  chartRoundMagnetStep: number;
  chartMode: string;
  chartCandles: CandleLike[];
  showVwap: boolean;
  dayVwap: number;
  weekVwap: number;
  monthVwap: number;
  showLiquidity: boolean;
  liquidityZones: LiquidityZoneLike[];
  crosshair: CrosshairLike;
  chartSnapPriority: ChartSnapPriority;
  chartSnapThreshold: number;
  chartAtrLocalPct: number;
}): { price: number; label: string; family: ChartSnapFamilyLike } {
  const clampedRawPrice = Math.max(chartPriceRangeMin, Math.min(chartPriceRangeMax, rawPrice));
  const stepPrice = quantizePriceToStep(clampedRawPrice, chartPriceStep);
  if (!chartSnapEnabled) {
    return { price: stepPrice, label: `STEP ${chartPriceStep.toFixed(chartPriceDigits)}`, family: "manual" };
  }

  const roundPrice = quantizePriceToStep(Math.round(clampedRawPrice / chartRoundMagnetStep) * chartRoundMagnetStep, chartPriceStep);
  const executionCandidates: SnapCandidate[] = [
    { price: quantizePriceToStep(current.entry > 0 ? current.entry : clampedRawPrice, chartPriceStep), label: "LIVE" },
    { price: roundPrice, label: `ROUND ${roundPrice.toFixed(chartPriceDigits)}` },
  ];
  if (chartMode === "candles" && chartCandles.length > 0) {
    for (const candle of chartCandles.slice(-36)) {
      executionCandidates.push(
        { price: quantizePriceToStep(candle.close, chartPriceStep), label: "CLOSE" },
        { price: quantizePriceToStep(candle.high, chartPriceStep), label: "HIGH" },
        { price: quantizePriceToStep(candle.low, chartPriceStep), label: "LOW" },
      );
    }
  }
  const vwapCandidates: SnapCandidate[] = [];
  const liquidityCandidates: SnapCandidate[] = [];
  if (showVwap) {
    vwapCandidates.push(
      { price: quantizePriceToStep(dayVwap, chartPriceStep), label: "VWAP D" },
      { price: quantizePriceToStep(weekVwap, chartPriceStep), label: "VWAP W" },
      { price: quantizePriceToStep(monthVwap, chartPriceStep), label: "VWAP M" },
    );
  }
  if (showLiquidity) {
    for (const zone of liquidityZones) {
      liquidityCandidates.push({ price: quantizePriceToStep(zone.level, chartPriceStep), label: zone.label.toUpperCase() });
    }
  }
  if (crosshair?.price) {
    executionCandidates.push({ price: quantizePriceToStep(crosshair.price, chartPriceStep), label: "CURSOR" });
  }

  const candidateGroups: Record<ChartSnapPriority, SnapCandidate[]> = {
    execution: executionCandidates,
    vwap: vwapCandidates,
    liquidity: liquidityCandidates,
  };
  const priorityOrder: ChartSnapPriority[] = [
    chartSnapPriority,
    ...(["execution", "vwap", "liquidity"] as const).filter((key) => key !== chartSnapPriority),
  ];

  let snapped = stepPrice;
  let label = `STEP ${chartPriceStep.toFixed(chartPriceDigits)}`;
  let family: ChartSnapFamilyLike = "manual";
  const atrWeight = clamp(1.16 - chartAtrLocalPct * 40, 0.52, 1.14);
  const lineWeight = line === "entry" ? 0.9 : 1;
  const adaptiveSnapThreshold = chartSnapThreshold * atrWeight * lineWeight;

  for (const groupName of priorityOrder) {
    let bestDistance = Number.POSITIVE_INFINITY;
    let groupWinner: SnapCandidate | null = null;
    for (const candidate of candidateGroups[groupName]) {
      if (!Number.isFinite(candidate.price) || candidate.price <= 0) {
        continue;
      }
      if (line !== "entry" && Math.abs(candidate.price - current.entry) < chartPriceStep) {
        continue;
      }
      const distance = Math.abs(clampedRawPrice - candidate.price);
      if (distance <= adaptiveSnapThreshold && distance < bestDistance) {
        groupWinner = candidate;
        bestDistance = distance;
      }
    }
    if (groupWinner) {
      snapped = groupWinner.price;
      label = groupWinner.label;
      family = groupName;
      break;
    }
  }

  return { price: snapped, label, family };
}

export function moveChartOrderLineTicket({
  current,
  line,
  rawPrice,
  referencePrice,
  chartPriceStep,
  snapped,
}: {
  current: ChartOrderTicketLike;
  line: ChartOrderLineKeyLike;
  rawPrice: number;
  referencePrice: number;
  chartPriceStep: number;
  snapped: { price: number; label: string; family: ChartSnapFamilyLike };
}): ChartOrderTicketLike {
  void rawPrice;
  const minGap = Math.max(chartPriceStep * 2, referencePrice * 0.0004);
  const next: ChartOrderTicketLike = { ...current, preset: "custom" };

  if (line === "entry") {
    const delta = snapped.price - current.entry;
    next.entry = snapped.price;
    next.sl = current.sl + delta;
    next.tp = current.tp + delta;
  } else {
    next[line] = snapped.price;
  }

  next.entry = Math.max(chartPriceStep, quantizePriceToStep(next.entry, chartPriceStep));
  next.sl = Math.max(chartPriceStep, quantizePriceToStep(next.sl, chartPriceStep));
  next.tp = Math.max(chartPriceStep, quantizePriceToStep(next.tp, chartPriceStep));

  if (next.side === "buy") {
    if (next.sl >= next.entry - minGap) {
      next.sl = quantizePriceToStep(next.entry - minGap, chartPriceStep);
    }
    if (next.tp <= next.entry + minGap) {
      next.tp = quantizePriceToStep(next.entry + minGap, chartPriceStep);
    }
  } else {
    if (next.sl <= next.entry + minGap) {
      next.sl = quantizePriceToStep(next.entry + minGap, chartPriceStep);
    }
    if (next.tp >= next.entry - minGap) {
      next.tp = quantizePriceToStep(next.entry - minGap, chartPriceStep);
    }
  }

  return next;
}