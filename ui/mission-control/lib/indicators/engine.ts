/**
 * Indicator engine — extensible plugin system for technical analysis.
 *
 * Usage:
 *   registerIndicator(def)
 *   computeIndicator("rsi", bars, { period: 14 })
 *   listIndicators()
 *
 * Indicators are split into two categories:
 *   overlay  — rendered on the price chart (EMA, BB, VWAP, …)
 *   panel    — rendered in a separate sub-chart (RSI, MACD, …)
 */

/** A single OHLCV bar with unix-second timestamp. */
export type BarData = {
  time: number;   // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** A single timestamped value row output by an indicator. */
export type IndicatorOutput = {
  time: number;
  [key: string]: number | null;
};

/** How a particular output key should be rendered on the chart. */
export type SeriesType = "line" | "histogram" | "area";

/** Description of one visual output line/histogram from an indicator. */
export type OutputDef = {
  key: string;
  label: string;
  color: string;
  type: SeriesType;
  /** "main" = overlay on price chart, "sub" = separate sub-panel */
  pane: "main" | "sub";
  lineWidth?: number;
  priceFormat?: "price" | "percent" | "volume";
};

/** A single configurable parameter in an indicator. */
export type ParamDef =
  | { type: "number"; label: string; default: number; min?: number; max?: number; step?: number }
  | { type: "boolean"; label: string; default: boolean }
  | { type: "select"; label: string; default: string; options: string[] };

/** The complete definition of an indicator plugin. */
export type IndicatorDef = {
  id: string;
  name: string;
  category: "trend" | "momentum" | "volume" | "volatility" | "custom";
  params: Record<string, ParamDef>;
  outputs: OutputDef[];
  compute(
    bars: BarData[],
    params: Record<string, number | boolean | string>,
  ): IndicatorOutput[];
};

/** An active indicator configuration requested by the user. */
export type ActiveIndicator = {
  id: string;
  params?: Record<string, number | boolean | string>;
};

/** Pre-computed series data ready to pass to the chart renderer. */
export type IndicatorSeriesData = {
  indicatorId: string;
  outputKey: string;
  label: string;
  color: string;
  type: SeriesType;
  pane: "main" | "sub";
  lineWidth: number;
  data: Array<{ time: number; value: number }>;
};

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, IndicatorDef>();

export function registerIndicator(def: IndicatorDef): void {
  registry.set(def.id, def);
}

export function getIndicator(id: string): IndicatorDef | undefined {
  return registry.get(id);
}

export function listIndicators(): IndicatorDef[] {
  return [...registry.values()];
}

// ─── Computation ─────────────────────────────────────────────────────────────

/**
 * Compute an indicator by id using the given bars and params (merges with defaults).
 * Returns [] if the indicator is not registered or there are no bars.
 */
export function computeIndicator(
  id: string,
  bars: BarData[],
  params?: Record<string, number | boolean | string>,
): IndicatorOutput[] {
  const def = registry.get(id);
  if (!def || bars.length === 0) {
    return [];
  }

  // Merge caller params with defaults
  const resolvedParams: Record<string, number | boolean | string> = {};
  for (const [key, paramDef] of Object.entries(def.params)) {
    resolvedParams[key] = params?.[key] !== undefined ? params[key] : paramDef.default;
  }

  return def.compute(bars, resolvedParams);
}

/**
 * Compute all active indicators and return pre-formatted series data
 * ready to pass into the InstitutionalChart `indicatorSeries` prop.
 */
export function computeAllIndicators(
  bars: BarData[],
  active: ActiveIndicator[],
): IndicatorSeriesData[] {
  if (bars.length === 0) {
    return [];
  }

  const result: IndicatorSeriesData[] = [];

  for (const activeInd of active) {
    const def = registry.get(activeInd.id);
    if (!def) {
      continue;
    }

    const outputs = computeIndicator(activeInd.id, bars, activeInd.params);

    for (const outputDef of def.outputs) {
      const seriesData: Array<{ time: number; value: number }> = [];
      for (const row of outputs) {
        const val = row[outputDef.key];
        if (val !== null && val !== undefined && Number.isFinite(val)) {
          seriesData.push({ time: row.time, value: val });
        }
      }
      result.push({
        indicatorId: activeInd.id,
        outputKey: outputDef.key,
        label: outputDef.label,
        color: outputDef.color,
        type: outputDef.type,
        pane: outputDef.pane,
        lineWidth: outputDef.lineWidth ?? 1,
        data: seriesData,
      });
    }
  }

  return result;
}

// ─── Helpers exported for use in builtins ────────────────────────────────────

export function toNum(value: number | boolean | string, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toBool(value: number | boolean | string, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return String(value) === "true" ? true : (String(value) === "false" ? false : fallback);
}
