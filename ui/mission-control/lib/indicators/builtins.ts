/**
 * Built-in indicator library.
 *
 * All indicators are registered at module import time.
 * Import this file once at app startup (e.g. in InstitutionalChart.tsx or page.tsx).
 *
 * Included:
 *   trend     — EMA, SMA, WMA, DEMA, VWAP
 *   momentum  — RSI, MACD, Stochastic, CCI, ROC, Momentum, CMF
 *   volatility— Bollinger Bands, ATR, Keltner Channel, Donchian Channel
 *   volume    — OBV, Volume SMA, CMF, CVD
 *   custom    — SuperTrend, Market Structure, ZigZag
 */

import { registerIndicator, toNum, toBool, type BarData, type IndicatorOutput } from "./engine";

// ════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════

function emaArray(values: number[], period: number): (number | null)[] {
  const alpha = 2 / (period + 1);
  const result: (number | null)[] = new Array(values.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result[i] = null;
    } else if (i === period - 1) {
      // seed with SMA
      const seed = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
      prev = seed;
      result[i] = seed;
    } else {
      const next = (values[i] - (prev ?? values[i])) * alpha + (prev ?? values[i]);
      prev = next;
      result[i] = next;
    }
  }
  return result;
}

function smaArray(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const slice = values.slice(i - period + 1, i + 1);
    result[i] = slice.reduce((s, v) => s + v, 0) / period;
  }
  return result;
}

function wmaArray(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let w = 0; w < period; w++) {
      sum += values[i - period + 1 + w] * (w + 1);
    }
    result[i] = sum / denom;
  }
  return result;
}

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function rollingStdev(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    result[i] = stdev(values.slice(i - period + 1, i + 1));
  }
  return result;
}

// ════════════════════════════════════════════════════════════
// TREND
// ════════════════════════════════════════════════════════════

registerIndicator({
  id: "ema",
  name: "EMA",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 2, max: 500 },
  },
  outputs: [
    { key: "ema", label: "EMA", color: "#f5c842", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 20));
    const closes = bars.map((b) => b.close);
    const emas = emaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, ema: emas[i] }));
  },
});

registerIndicator({
  id: "ema9",
  name: "EMA 9",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 9, min: 2, max: 200 },
  },
  outputs: [
    { key: "ema", label: "EMA9", color: "#a78bfa", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 9));
    const closes = bars.map((b) => b.close);
    const emas = emaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, ema: emas[i] }));
  },
});

registerIndicator({
  id: "ema21",
  name: "EMA 21",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 21, min: 2, max: 200 },
  },
  outputs: [
    { key: "ema", label: "EMA21", color: "#34d399", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 21));
    const closes = bars.map((b) => b.close);
    const emas = emaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, ema: emas[i] }));
  },
});

registerIndicator({
  id: "ema50",
  name: "EMA 50",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 50, min: 2, max: 500 },
  },
  outputs: [
    { key: "ema", label: "EMA50", color: "#fb923c", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 50));
    const closes = bars.map((b) => b.close);
    const emas = emaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, ema: emas[i] }));
  },
});

registerIndicator({
  id: "ema200",
  name: "EMA 200",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 200, min: 2, max: 500 },
  },
  outputs: [
    { key: "ema", label: "EMA200", color: "#f87171", type: "line", pane: "main", lineWidth: 2 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 200));
    const closes = bars.map((b) => b.close);
    const emas = emaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, ema: emas[i] }));
  },
});

registerIndicator({
  id: "sma",
  name: "SMA",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 2, max: 500 },
  },
  outputs: [
    { key: "sma", label: "SMA", color: "#60a5fa", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 20));
    const closes = bars.map((b) => b.close);
    const smas = smaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, sma: smas[i] }));
  },
});

registerIndicator({
  id: "wma",
  name: "WMA",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 14, min: 2, max: 200 },
  },
  outputs: [
    { key: "wma", label: "WMA", color: "#c084fc", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 14));
    const closes = bars.map((b) => b.close);
    const wmas = wmaArray(closes, period);
    return bars.map((b, i) => ({ time: b.time, wma: wmas[i] }));
  },
});

registerIndicator({
  id: "dema",
  name: "DEMA",
  category: "trend",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 2, max: 200 },
  },
  outputs: [
    { key: "dema", label: "DEMA", color: "#2dd4bf", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 20));
    const closes = bars.map((b) => b.close);
    const ema1 = emaArray(closes, period);
    const ema2 = emaArray(ema1.map((v) => v ?? 0), period);
    return bars.map((b, i) => ({
      time: b.time,
      dema: ema1[i] !== null && ema2[i] !== null ? 2 * (ema1[i] ?? 0) - (ema2[i] ?? 0) : null,
    }));
  },
});

// VWAP (daily anchor by default)
registerIndicator({
  id: "vwap",
  name: "VWAP",
  category: "trend",
  params: {
    anchor: { type: "select", label: "Anchor", default: "session", options: ["session", "week", "month"] },
  },
  outputs: [
    { key: "vwap", label: "VWAP", color: "#67e8a5", type: "line", pane: "main", lineWidth: 2 },
    { key: "upper1", label: "VWAP +1σ", color: "rgba(103,232,165,0.4)", type: "line", pane: "main", lineWidth: 1 },
    { key: "lower1", label: "VWAP −1σ", color: "rgba(103,232,165,0.4)", type: "line", pane: "main", lineWidth: 1 },
    { key: "upper2", label: "VWAP +2σ", color: "rgba(103,232,165,0.2)", type: "line", pane: "main", lineWidth: 1 },
    { key: "lower2", label: "VWAP −2σ", color: "rgba(103,232,165,0.2)", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[]): IndicatorOutput[] {
    const result: IndicatorOutput[] = [];
    let cumTypicalVol = 0;
    let cumVol = 0;
    let cumSqDiffVol = 0;

    for (const bar of bars) {
      const typical = (bar.high + bar.low + bar.close) / 3;
      cumTypicalVol += typical * bar.volume;
      cumVol += bar.volume;
      const vwap = cumVol > 0 ? cumTypicalVol / cumVol : typical;
      cumSqDiffVol += (typical - vwap) ** 2 * bar.volume;
      const variance = cumVol > 0 ? cumSqDiffVol / cumVol : 0;
      const sd = Math.sqrt(Math.max(0, variance));
      result.push({
        time: bar.time,
        vwap,
        upper1: vwap + sd,
        lower1: vwap - sd,
        upper2: vwap + 2 * sd,
        lower2: vwap - 2 * sd,
      });
    }
    return result;
  },
});

// ════════════════════════════════════════════════════════════
// MOMENTUM
// ════════════════════════════════════════════════════════════

registerIndicator({
  id: "rsi",
  name: "RSI",
  category: "momentum",
  params: {
    period: { type: "number", label: "Period", default: 14, min: 2, max: 100 },
  },
  outputs: [
    { key: "rsi", label: "RSI", color: "#a78bfa", type: "line", pane: "sub", lineWidth: 1 },
    { key: "ob", label: "OB 70", color: "rgba(248,113,113,0.4)", type: "line", pane: "sub", lineWidth: 1 },
    { key: "os", label: "OS 30", color: "rgba(52,211,153,0.4)", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 14));
    const result: IndicatorOutput[] = [];
    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 0; i < bars.length; i++) {
      const delta = i > 0 ? bars[i].close - bars[i - 1].close : 0;
      const gain = Math.max(0, delta);
      const loss = Math.max(0, -delta);

      if (i < period) {
        avgGain += gain / period;
        avgLoss += loss / period;
        result.push({ time: bars[i].time, rsi: null, ob: 70, os: 30 });
      } else if (i === period) {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
        result.push({ time: bars[i].time, rsi: 100 - 100 / (1 + rs), ob: 70, os: 30 });
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
        result.push({ time: bars[i].time, rsi: 100 - 100 / (1 + rs), ob: 70, os: 30 });
      }
    }
    return result;
  },
});

registerIndicator({
  id: "macd",
  name: "MACD",
  category: "momentum",
  params: {
    fast: { type: "number", label: "Fast", default: 12, min: 2, max: 50 },
    slow: { type: "number", label: "Slow", default: 26, min: 5, max: 100 },
    signal: { type: "number", label: "Signal", default: 9, min: 2, max: 50 },
  },
  outputs: [
    { key: "macd", label: "MACD", color: "#60a5fa", type: "line", pane: "sub", lineWidth: 1 },
    { key: "signal", label: "Signal", color: "#f5c842", type: "line", pane: "sub", lineWidth: 1 },
    { key: "histogram", label: "Hist", color: "#4ade80", type: "histogram", pane: "sub" },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const fast = Math.max(2, toNum(params.fast, 12));
    const slow = Math.max(5, toNum(params.slow, 26));
    const signalPeriod = Math.max(2, toNum(params.signal, 9));
    const closes = bars.map((b) => b.close);
    const emaFast = emaArray(closes, fast);
    const emaSlow = emaArray(closes, slow);
    const macdLine = bars.map((_, i) => {
      const f = emaFast[i];
      const s = emaSlow[i];
      return f !== null && s !== null ? f - s : null;
    });
    const macdValues = macdLine.map((v) => v ?? 0);
    const signalLine = emaArray(macdValues, signalPeriod);

    return bars.map((b, i) => {
      const m = macdLine[i];
      const s = i >= slow - 1 ? signalLine[i] : null;
      const h = m !== null && s !== null ? m - s : null;
      return { time: b.time, macd: m, signal: s, histogram: h };
    });
  },
});

registerIndicator({
  id: "stoch",
  name: "Stochastic",
  category: "momentum",
  params: {
    kPeriod: { type: "number", label: "%K Period", default: 14, min: 2, max: 100 },
    dPeriod: { type: "number", label: "%D Smooth", default: 3, min: 1, max: 20 },
  },
  outputs: [
    { key: "k", label: "%K", color: "#60a5fa", type: "line", pane: "sub", lineWidth: 1 },
    { key: "d", label: "%D", color: "#f5c842", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const kPeriod = Math.max(2, toNum(params.kPeriod, 14));
    const dPeriod = Math.max(1, toNum(params.dPeriod, 3));
    const kLine: (number | null)[] = [];

    for (let i = 0; i < bars.length; i++) {
      if (i < kPeriod - 1) {
        kLine.push(null);
        continue;
      }
      const slice = bars.slice(i - kPeriod + 1, i + 1);
      const lowest = Math.min(...slice.map((b) => b.low));
      const highest = Math.max(...slice.map((b) => b.high));
      kLine.push(highest === lowest ? 50 : ((bars[i].close - lowest) / (highest - lowest)) * 100);
    }

    const dLine = smaArray(kLine.map((v) => v ?? 0), dPeriod);
    return bars.map((b, i) => ({
      time: b.time,
      k: kLine[i],
      d: kLine[i] !== null ? dLine[i] : null,
    }));
  },
});

registerIndicator({
  id: "cci",
  name: "CCI",
  category: "momentum",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 5, max: 200 },
  },
  outputs: [
    { key: "cci", label: "CCI", color: "#fbbf24", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(5, toNum(params.period, 20));
    return bars.map((b, i) => {
      if (i < period - 1) return { time: b.time, cci: null };
      const slice = bars.slice(i - period + 1, i + 1);
      const typs = slice.map((x) => (x.high + x.low + x.close) / 3);
      const mean = typs.reduce((s, v) => s + v, 0) / period;
      const mad = typs.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
      const tp = (b.high + b.low + b.close) / 3;
      return { time: b.time, cci: mad > 0 ? (tp - mean) / (0.015 * mad) : 0 };
    });
  },
});

registerIndicator({
  id: "momentum",
  name: "Momentum",
  category: "momentum",
  params: {
    period: { type: "number", label: "Period", default: 10, min: 1, max: 200 },
  },
  outputs: [
    { key: "mom", label: "MOM", color: "#a78bfa", type: "histogram", pane: "sub" },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(1, toNum(params.period, 10));
    return bars.map((b, i) => ({
      time: b.time,
      mom: i >= period ? b.close - bars[i - period].close : null,
    }));
  },
});

registerIndicator({
  id: "roc",
  name: "Rate of Change",
  category: "momentum",
  params: {
    period: { type: "number", label: "Period", default: 12, min: 1, max: 200 },
  },
  outputs: [
    { key: "roc", label: "ROC", color: "#38bdf8", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(1, toNum(params.period, 12));
    return bars.map((b, i) => ({
      time: b.time,
      roc: i >= period && bars[i - period].close !== 0
        ? ((b.close - bars[i - period].close) / bars[i - period].close) * 100
        : null,
    }));
  },
});

// ════════════════════════════════════════════════════════════
// VOLATILITY
// ════════════════════════════════════════════════════════════

registerIndicator({
  id: "bb",
  name: "Bollinger Bands",
  category: "volatility",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 5, max: 200 },
    mult: { type: "number", label: "Multiplier", default: 2, min: 0.5, max: 5, step: 0.1 },
  },
  outputs: [
    { key: "upper", label: "BB Upper", color: "rgba(96,165,250,0.7)", type: "line", pane: "main", lineWidth: 1 },
    { key: "basis", label: "BB Basis", color: "rgba(96,165,250,0.4)", type: "line", pane: "main", lineWidth: 1 },
    { key: "lower", label: "BB Lower", color: "rgba(96,165,250,0.7)", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(5, toNum(params.period, 20));
    const mult = Math.max(0.5, toNum(params.mult, 2));
    const closes = bars.map((b) => b.close);
    const basis = smaArray(closes, period);
    const sdArr = rollingStdev(closes, period);
    return bars.map((b, i) => ({
      time: b.time,
      upper: basis[i] !== null && sdArr[i] !== null ? (basis[i] ?? 0) + mult * (sdArr[i] ?? 0) : null,
      basis: basis[i],
      lower: basis[i] !== null && sdArr[i] !== null ? (basis[i] ?? 0) - mult * (sdArr[i] ?? 0) : null,
    }));
  },
});

registerIndicator({
  id: "atr",
  name: "ATR",
  category: "volatility",
  params: {
    period: { type: "number", label: "Period", default: 14, min: 2, max: 200 },
  },
  outputs: [
    { key: "atr", label: "ATR", color: "#fb923c", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 14));
    const result: IndicatorOutput[] = [];
    let prevAtr: number | null = null;

    for (let i = 0; i < bars.length; i++) {
      const tr = i === 0
        ? bars[i].high - bars[i].low
        : Math.max(
            bars[i].high - bars[i].low,
            Math.abs(bars[i].high - bars[i - 1].close),
            Math.abs(bars[i].low - bars[i - 1].close),
          );

      if (i < period - 1) {
        result.push({ time: bars[i].time, atr: null });
      } else if (i === period - 1) {
        const sumTr = bars.slice(0, period).reduce((s, b, j) => {
          const t = j === 0 ? b.high - b.low : Math.max(
            b.high - b.low,
            Math.abs(b.high - bars[j - 1].close),
            Math.abs(b.low - bars[j - 1].close),
          );
          return s + t;
        }, 0);
        prevAtr = sumTr / period;
        result.push({ time: bars[i].time, atr: prevAtr });
      } else {
        prevAtr = ((prevAtr ?? tr) * (period - 1) + tr) / period;
        result.push({ time: bars[i].time, atr: prevAtr });
      }
    }
    return result;
  },
});

registerIndicator({
  id: "keltner",
  name: "Keltner Channel",
  category: "volatility",
  params: {
    emaPeriod: { type: "number", label: "EMA Period", default: 20, min: 5, max: 200 },
    atrPeriod: { type: "number", label: "ATR Period", default: 10, min: 2, max: 100 },
    mult: { type: "number", label: "Mult", default: 2, min: 0.5, max: 5, step: 0.1 },
  },
  outputs: [
    { key: "upper", label: "KC Upper", color: "rgba(251,146,60,0.6)", type: "line", pane: "main", lineWidth: 1 },
    { key: "mid", label: "KC Mid", color: "rgba(251,146,60,0.4)", type: "line", pane: "main", lineWidth: 1 },
    { key: "lower", label: "KC Lower", color: "rgba(251,146,60,0.6)", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const emaPeriod = Math.max(5, toNum(params.emaPeriod, 20));
    const atrPeriod = Math.max(2, toNum(params.atrPeriod, 10));
    const mult = Math.max(0.5, toNum(params.mult, 2));
    const closes = bars.map((b) => b.close);
    const emas = emaArray(closes, emaPeriod);

    // Simple ATR per bar
    const atrs: (number | null)[] = [];
    let avgAtr: number | null = null;
    for (let i = 0; i < bars.length; i++) {
      const tr = i === 0 ? bars[i].high - bars[i].low : Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      );
      if (i < atrPeriod - 1) { atrs.push(null); continue; }
      if (i === atrPeriod - 1) {
        avgAtr = bars.slice(0, atrPeriod).reduce((s, b, j) => s + (j === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[j-1].close), Math.abs(b.low - bars[j-1].close))), 0) / atrPeriod;
      } else {
        avgAtr = ((avgAtr ?? tr) * (atrPeriod - 1) + tr) / atrPeriod;
      }
      atrs.push(avgAtr);
    }

    return bars.map((b, i) => {
      const e = emas[i];
      const a = atrs[i];
      if (e === null || a === null) return { time: b.time, upper: null, mid: null, lower: null };
      return { time: b.time, upper: e + mult * a, mid: e, lower: e - mult * a };
    });
  },
});

registerIndicator({
  id: "donchian",
  name: "Donchian Channel",
  category: "volatility",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 5, max: 200 },
  },
  outputs: [
    { key: "upper", label: "DC High", color: "rgba(248,113,113,0.5)", type: "line", pane: "main", lineWidth: 1 },
    { key: "mid", label: "DC Mid", color: "rgba(248,113,113,0.3)", type: "line", pane: "main", lineWidth: 1 },
    { key: "lower", label: "DC Low", color: "rgba(248,113,113,0.5)", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(5, toNum(params.period, 20));
    return bars.map((b, i) => {
      if (i < period - 1) return { time: b.time, upper: null, mid: null, lower: null };
      const slice = bars.slice(i - period + 1, i + 1);
      const upper = Math.max(...slice.map((x) => x.high));
      const lower = Math.min(...slice.map((x) => x.low));
      return { time: b.time, upper, mid: (upper + lower) / 2, lower };
    });
  },
});

// ════════════════════════════════════════════════════════════
// VOLUME
// ════════════════════════════════════════════════════════════

registerIndicator({
  id: "obv",
  name: "OBV",
  category: "volume",
  params: {},
  outputs: [
    { key: "obv", label: "OBV", color: "#38bdf8", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[]): IndicatorOutput[] {
    let obv = 0;
    return bars.map((b, i) => {
      if (i > 0) {
        if (b.close > bars[i - 1].close) obv += b.volume;
        else if (b.close < bars[i - 1].close) obv -= b.volume;
      }
      return { time: b.time, obv };
    });
  },
});

registerIndicator({
  id: "volsma",
  name: "Volume SMA",
  category: "volume",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 2, max: 200 },
  },
  outputs: [
    { key: "vol", label: "Volume", color: "rgba(96,165,250,0.5)", type: "histogram", pane: "sub" },
    { key: "sma", label: "Vol SMA", color: "#f5c842", type: "line", pane: "sub", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 20));
    const vols = bars.map((b) => b.volume);
    const smas = smaArray(vols, period);
    return bars.map((b, i) => ({ time: b.time, vol: b.volume, sma: smas[i] }));
  },
});

// CVD (Cumulative Volume Delta — approximated from OHLCV)
registerIndicator({
  id: "cvd",
  name: "CVD",
  category: "volume",
  params: {},
  outputs: [
    { key: "cvd", label: "CVD", color: "#4ade80", type: "histogram", pane: "sub" },
  ],
  compute(bars: BarData[]): IndicatorOutput[] {
    let cumDelta = 0;
    return bars.map((b) => {
      // Approximate bid/ask split from candle direction + wicks
      const range = Math.max(b.high - b.low, 0.0001);
      const buyFraction = (b.close - b.low) / range;
      const delta = b.volume * (2 * buyFraction - 1); // positive = net buying
      cumDelta += delta;
      return { time: b.time, cvd: cumDelta };
    });
  },
});

// CMF (Chaikin Money Flow)
registerIndicator({
  id: "cmf",
  name: "CMF",
  category: "volume",
  params: {
    period: { type: "number", label: "Period", default: 20, min: 5, max: 100 },
  },
  outputs: [
    { key: "cmf", label: "CMF", color: "#34d399", type: "histogram", pane: "sub" },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(5, toNum(params.period, 20));
    return bars.map((b, i) => {
      if (i < period - 1) return { time: b.time, cmf: null };
      const slice = bars.slice(i - period + 1, i + 1);
      const sumMfv = slice.reduce((s, bar) => {
        const hl = bar.high - bar.low;
        const mfm = hl > 0 ? ((bar.close - bar.low) - (bar.high - bar.close)) / hl : 0;
        return s + mfm * bar.volume;
      }, 0);
      const sumVol = slice.reduce((s, bar) => s + bar.volume, 0);
      return { time: b.time, cmf: sumVol > 0 ? sumMfv / sumVol : 0 };
    });
  },
});

// ════════════════════════════════════════════════════════════
// CUSTOM (advanced)
// ════════════════════════════════════════════════════════════

// SuperTrend
registerIndicator({
  id: "supertrend",
  name: "SuperTrend",
  category: "custom",
  params: {
    period: { type: "number", label: "ATR Period", default: 10, min: 2, max: 100 },
    mult: { type: "number", label: "Multiplier", default: 3, min: 0.5, max: 10, step: 0.1 },
  },
  outputs: [
    { key: "up", label: "ST Bull", color: "#4ade80", type: "line", pane: "main", lineWidth: 2 },
    { key: "dn", label: "ST Bear", color: "#f87171", type: "line", pane: "main", lineWidth: 2 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const period = Math.max(2, toNum(params.period, 10));
    const mult = Math.max(0.5, toNum(params.mult, 3));
    const result: IndicatorOutput[] = [];
    let prevAtr = 0;
    let prevUp = 0;
    let prevDn = 0;
    let trend = 1; // 1=bull, -1=bear

    for (let i = 0; i < bars.length; i++) {
      const hl2 = (bars[i].high + bars[i].low) / 2;
      const tr = i === 0 ? bars[i].high - bars[i].low : Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      );
      const atr = i === 0 ? tr : (prevAtr * (period - 1) + tr) / period;
      prevAtr = atr;

      const upper = hl2 + mult * atr;
      const lower = hl2 - mult * atr;

      const finalUp = (i === 0 || upper < prevUp || bars[i - 1].close < prevUp) ? upper : prevUp;
      const finalDn = (i === 0 || lower > prevDn || bars[i - 1].close > prevDn) ? lower : prevDn;

      if (trend === 1 && bars[i].close < finalUp) trend = -1;
      else if (trend === -1 && bars[i].close > finalDn) trend = 1;

      prevUp = finalUp;
      prevDn = finalDn;

      result.push({
        time: bars[i].time,
        up: trend === 1 ? finalDn : null,
        dn: trend === -1 ? finalUp : null,
      });
    }
    return result;
  },
});

// Market Structure (simplified swing highs/lows)
registerIndicator({
  id: "market_structure",
  name: "Market Structure",
  category: "custom",
  params: {
    lookback: { type: "number", label: "Lookback", default: 5, min: 2, max: 30 },
  },
  outputs: [
    { key: "hh", label: "HH", color: "#4ade80", type: "line", pane: "main", lineWidth: 1 },
    { key: "ll", label: "LL", color: "#f87171", type: "line", pane: "main", lineWidth: 1 },
  ],
  compute(bars: BarData[], params): IndicatorOutput[] {
    const lb = Math.max(2, toNum(params.lookback, 5));
    return bars.map((b, i) => {
      if (i < lb) return { time: b.time, hh: null, ll: null };
      const slice = bars.slice(i - lb, i);
      const isSwingHigh = slice.every((x) => b.high > x.high);
      const isSwingLow = slice.every((x) => b.low < x.low);
      return {
        time: b.time,
        hh: isSwingHigh ? b.high : null,
        ll: isSwingLow ? b.low : null,
      };
    });
  },
});

// Export helper for quick indicator list
export function getBuiltinCategories(): Array<{ category: string; ids: string[] }> {
  const map = new Map<string, string[]>();
  for (const [id, def] of Object.entries({
    ema: "trend", ema9: "trend", ema21: "trend", ema50: "trend", ema200: "trend",
    sma: "trend", wma: "trend", dema: "trend", vwap: "trend",
    rsi: "momentum", macd: "momentum", stoch: "momentum", cci: "momentum",
    momentum: "momentum", roc: "momentum",
    bb: "volatility", atr: "volatility", keltner: "volatility", donchian: "volatility",
    obv: "volume", volsma: "volume", cvd: "volume", cmf: "volume",
    supertrend: "custom", market_structure: "custom",
  })) {
    const list = map.get(def) ?? [];
    list.push(id);
    map.set(def, list);
  }
  return [...map.entries()].map(([category, ids]) => ({ category, ids }));
}
