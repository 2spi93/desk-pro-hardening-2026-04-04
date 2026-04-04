/* eslint-disable no-restricted-globals */
// =============================================================================
// indicatorWorker.js — Off-main-thread indicator compute worker.
// All builtins from lib/indicators/builtins.ts reproduced as self-contained JS.
// No imports allowed — must stay vanilla JS for public/ static serving.
// =============================================================================

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ─── Primitive array helpers ──────────────────────────────────────────────────

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const alpha = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i += 1) acc += values[i];
  out[period - 1] = acc / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function wma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    for (let w = 0; w < period; w += 1) sum += values[i - period + 1 + w] * (w + 1);
    out[i] = sum / denom;
  }
  return out;
}

function rollingStdev(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/** Returns Wilder ATR array (null until period-1) */
function atrArray(bars, period) {
  const out = new Array(bars.length).fill(null);
  let prevAtr = null;
  for (let i = 0; i < bars.length; i += 1) {
    const tr =
      i === 0
        ? toNum(bars[i].high, 0) - toNum(bars[i].low, 0)
        : Math.max(
            toNum(bars[i].high, 0) - toNum(bars[i].low, 0),
            Math.abs(toNum(bars[i].high, 0) - toNum(bars[i - 1].close, 0)),
            Math.abs(toNum(bars[i].low, 0) - toNum(bars[i - 1].close, 0)),
          );
    if (i < period - 1) continue;
    if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j += 1) {
        sum +=
          j === 0
            ? toNum(bars[j].high, 0) - toNum(bars[j].low, 0)
            : Math.max(
                toNum(bars[j].high, 0) - toNum(bars[j].low, 0),
                Math.abs(toNum(bars[j].high, 0) - toNum(bars[j - 1].close, 0)),
                Math.abs(toNum(bars[j].low, 0) - toNum(bars[j - 1].close, 0)),
              );
      }
      prevAtr = sum / period;
      out[i] = prevAtr;
    } else {
      prevAtr = ((prevAtr !== null ? prevAtr : tr) * (period - 1) + tr) / period;
      out[i] = prevAtr;
    }
  }
  return out;
}

/** Push a {time, value} point only if value is a finite number. */
function pushIfFinite(arr, time, value) {
  if (value !== null && Number.isFinite(value)) arr.push({ time, value });
}

// ─── Trend ───────────────────────────────────────────────────────────────────

function computeEMAIndicator(id, bars, period, color) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const arr = ema(closes, period);
  const data = [];
  for (let i = 0; i < bars.length; i += 1) pushIfFinite(data, toNum(bars[i].time, 0), arr[i]);
  return [{ indicatorId: id, outputKey: "ema", label: `EMA ${period}`, color, type: "line", pane: "main", lineWidth: 2, data }];
}

function computeSMAIndicator(id, bars, period, color) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const arr = sma(closes, period);
  const data = [];
  for (let i = 0; i < bars.length; i += 1) pushIfFinite(data, toNum(bars[i].time, 0), arr[i]);
  return [{ indicatorId: id, outputKey: "sma", label: `SMA ${period}`, color, type: "line", pane: "main", lineWidth: 2, data }];
}

function computeWMAIndicator(id, bars, period, color) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const arr = wma(closes, period);
  const data = [];
  for (let i = 0; i < bars.length; i += 1) pushIfFinite(data, toNum(bars[i].time, 0), arr[i]);
  return [{ indicatorId: id, outputKey: "wma", label: `WMA ${period}`, color, type: "line", pane: "main", lineWidth: 2, data }];
}

function computeDEMAIndicator(id, bars, period, color) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const ema1 = ema(closes, period);
  const ema2 = ema(ema1.map((v) => (v === null ? 0 : v)), period);
  const data = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (ema1[i] !== null && ema2[i] !== null) {
      pushIfFinite(data, toNum(bars[i].time, 0), 2 * ema1[i] - ema2[i]);
    }
  }
  return [{ indicatorId: id, outputKey: "dema", label: `DEMA ${period}`, color, type: "line", pane: "main", lineWidth: 2, data }];
}

function computeVWAPIndicator(id, bars) {
  let cumTypVol = 0, cumVol = 0, cumSqDiffVol = 0;
  const vwapData = [], upper1 = [], lower1 = [], upper2 = [], lower2 = [];
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    const typical = (toNum(b.high, 0) + toNum(b.low, 0) + toNum(b.close, 0)) / 3;
    const vol = toNum(b.volume, 0);
    cumTypVol += typical * vol;
    cumVol += vol;
    const v = cumVol > 0 ? cumTypVol / cumVol : typical;
    cumSqDiffVol += (typical - v) ** 2 * vol;
    const sd = Math.sqrt(Math.max(0, cumVol > 0 ? cumSqDiffVol / cumVol : 0));
    const t = toNum(b.time, 0);
    vwapData.push({ time: t, value: v });
    upper1.push({ time: t, value: v + sd });
    lower1.push({ time: t, value: v - sd });
    upper2.push({ time: t, value: v + 2 * sd });
    lower2.push({ time: t, value: v - 2 * sd });
  }
  return [
    { indicatorId: id, outputKey: "vwap",   label: "VWAP",      color: "#67e8a5",              type: "line", pane: "main", lineWidth: 2, data: vwapData },
    { indicatorId: id, outputKey: "upper1", label: "VWAP +1σ",  color: "rgba(103,232,165,0.4)", type: "line", pane: "main", lineWidth: 1, data: upper1 },
    { indicatorId: id, outputKey: "lower1", label: "VWAP -1σ",  color: "rgba(103,232,165,0.4)", type: "line", pane: "main", lineWidth: 1, data: lower1 },
    { indicatorId: id, outputKey: "upper2", label: "VWAP +2σ",  color: "rgba(103,232,165,0.2)", type: "line", pane: "main", lineWidth: 1, data: upper2 },
    { indicatorId: id, outputKey: "lower2", label: "VWAP -2σ",  color: "rgba(103,232,165,0.2)", type: "line", pane: "main", lineWidth: 1, data: lower2 },
  ];
}

// ─── Momentum ─────────────────────────────────────────────────────────────────

function computeRSIIndicator(id, bars, period) {
  const closes = bars.map((b) => toNum(b.close, 0));
  if (closes.length < period + 1) return [];
  const rsiArr = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) avgGain += d / period;
    else avgLoss += -d / period;
  }
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  const data = [];
  for (let i = 0; i < bars.length; i += 1) pushIfFinite(data, toNum(bars[i].time, 0), rsiArr[i]);
  return [{ indicatorId: id, outputKey: "rsi", label: "RSI", color: "#8ab4ff", type: "line", pane: "sub", lineWidth: 2, data }];
}

function computeMACDIndicator(id, bars, fast, slow, signal) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdRaw = closes.map((_, i) =>
    fastEma[i] !== null && slowEma[i] !== null ? fastEma[i] - slowEma[i] : null,
  );
  const signalArr = ema(macdRaw.map((v) => (v === null ? 0 : v)), signal);
  const macdData = [], signalData = [], histData = [];
  for (let i = 0; i < bars.length; i += 1) {
    const t = toNum(bars[i].time, 0);
    pushIfFinite(macdData, t, macdRaw[i]);
    pushIfFinite(signalData, t, signalArr[i]);
    if (macdRaw[i] !== null && signalArr[i] !== null) {
      pushIfFinite(histData, t, macdRaw[i] - signalArr[i]);
    }
  }
  return [
    { indicatorId: id, outputKey: "macd",      label: "MACD",    color: "#58c7ff", type: "line",      pane: "sub", lineWidth: 2, data: macdData },
    { indicatorId: id, outputKey: "signal",    label: "Signal",  color: "#ffd166", type: "line",      pane: "sub", lineWidth: 2, data: signalData },
    { indicatorId: id, outputKey: "histogram", label: "Hist",    color: "#4ade80", type: "histogram", pane: "sub", lineWidth: 1, data: histData },
  ];
}

function computeStochIndicator(id, bars, kPeriod, dPeriod) {
  const kLine = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i < kPeriod - 1) { kLine.push(null); continue; }
    let lowest = Infinity, highest = -Infinity;
    for (let j = i - kPeriod + 1; j <= i; j += 1) {
      if (toNum(bars[j].low, 0) < lowest) lowest = toNum(bars[j].low, 0);
      if (toNum(bars[j].high, 0) > highest) highest = toNum(bars[j].high, 0);
    }
    kLine.push(highest === lowest ? 50 : ((toNum(bars[i].close, 0) - lowest) / (highest - lowest)) * 100);
  }
  const dArr = sma(kLine.map((v) => (v === null ? 0 : v)), dPeriod);
  const kData = [], dData = [];
  for (let i = 0; i < bars.length; i += 1) {
    const t = toNum(bars[i].time, 0);
    if (kLine[i] !== null) { pushIfFinite(kData, t, kLine[i]); }
    if (kLine[i] !== null && dArr[i] !== null) pushIfFinite(dData, t, dArr[i]);
  }
  return [
    { indicatorId: id, outputKey: "k", label: "%K", color: "#60a5fa", type: "line", pane: "sub", lineWidth: 2, data: kData },
    { indicatorId: id, outputKey: "d", label: "%D", color: "#f5c842", type: "line", pane: "sub", lineWidth: 2, data: dData },
  ];
}

function computeCCIIndicator(id, bars, period) {
  const data = [];
  for (let i = period - 1; i < bars.length; i += 1) {
    const typs = [];
    for (let j = i - period + 1; j <= i; j += 1) {
      typs.push((toNum(bars[j].high, 0) + toNum(bars[j].low, 0) + toNum(bars[j].close, 0)) / 3);
    }
    const mean = typs.reduce((s, v) => s + v, 0) / period;
    const mad = typs.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
    const tp = (toNum(bars[i].high, 0) + toNum(bars[i].low, 0) + toNum(bars[i].close, 0)) / 3;
    data.push({ time: toNum(bars[i].time, 0), value: mad > 0 ? (tp - mean) / (0.015 * mad) : 0 });
  }
  return [{ indicatorId: id, outputKey: "cci", label: `CCI ${period}`, color: "#fbbf24", type: "line", pane: "sub", lineWidth: 2, data }];
}

function computeMomentumIndicator(id, bars, period) {
  const data = [];
  for (let i = period; i < bars.length; i += 1) {
    data.push({ time: toNum(bars[i].time, 0), value: toNum(bars[i].close, 0) - toNum(bars[i - period].close, 0) });
  }
  return [{ indicatorId: id, outputKey: "mom", label: `MOM ${period}`, color: "#a78bfa", type: "histogram", pane: "sub", lineWidth: 1, data }];
}

function computeROCIndicator(id, bars, period) {
  const data = [];
  for (let i = period; i < bars.length; i += 1) {
    const prev = toNum(bars[i - period].close, 0);
    if (prev !== 0) data.push({ time: toNum(bars[i].time, 0), value: ((toNum(bars[i].close, 0) - prev) / prev) * 100 });
  }
  return [{ indicatorId: id, outputKey: "roc", label: `ROC ${period}`, color: "#38bdf8", type: "line", pane: "sub", lineWidth: 2, data }];
}

// ─── Volatility ───────────────────────────────────────────────────────────────

function computeBBIndicator(id, bars, period, mult) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const basis = sma(closes, period);
  const sdArr = rollingStdev(closes, period);
  const upperData = [], basisData = [], lowerData = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (basis[i] === null || sdArr[i] === null) continue;
    const t = toNum(bars[i].time, 0);
    basisData.push({ time: t, value: basis[i] });
    upperData.push({ time: t, value: basis[i] + mult * sdArr[i] });
    lowerData.push({ time: t, value: basis[i] - mult * sdArr[i] });
  }
  return [
    { indicatorId: id, outputKey: "upper", label: "BB Upper", color: "rgba(96,165,250,0.7)", type: "line", pane: "main", lineWidth: 1, data: upperData },
    { indicatorId: id, outputKey: "basis", label: "BB Basis", color: "rgba(96,165,250,0.4)", type: "line", pane: "main", lineWidth: 1, data: basisData },
    { indicatorId: id, outputKey: "lower", label: "BB Lower", color: "rgba(96,165,250,0.7)", type: "line", pane: "main", lineWidth: 1, data: lowerData },
  ];
}

function computeATRIndicator(id, bars, period) {
  const atrs = atrArray(bars, period);
  const data = [];
  for (let i = 0; i < bars.length; i += 1) pushIfFinite(data, toNum(bars[i].time, 0), atrs[i]);
  return [{ indicatorId: id, outputKey: "atr", label: `ATR ${period}`, color: "#fb923c", type: "line", pane: "sub", lineWidth: 2, data }];
}

function computeKeltnerIndicator(id, bars, emaPeriod, atrPeriod, mult) {
  const closes = bars.map((b) => toNum(b.close, 0));
  const emas = ema(closes, emaPeriod);
  const atrs = atrArray(bars, atrPeriod);
  const upperData = [], midData = [], lowerData = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (emas[i] === null || atrs[i] === null) continue;
    const t = toNum(bars[i].time, 0);
    upperData.push({ time: t, value: emas[i] + mult * atrs[i] });
    midData.push({ time: t, value: emas[i] });
    lowerData.push({ time: t, value: emas[i] - mult * atrs[i] });
  }
  return [
    { indicatorId: id, outputKey: "upper", label: "KC Upper", color: "rgba(251,146,60,0.6)", type: "line", pane: "main", lineWidth: 1, data: upperData },
    { indicatorId: id, outputKey: "mid",   label: "KC Mid",   color: "rgba(251,146,60,0.4)", type: "line", pane: "main", lineWidth: 1, data: midData },
    { indicatorId: id, outputKey: "lower", label: "KC Lower", color: "rgba(251,146,60,0.6)", type: "line", pane: "main", lineWidth: 1, data: lowerData },
  ];
}

function computeDonchianIndicator(id, bars, period) {
  const upperData = [], midData = [], lowerData = [];
  for (let i = period - 1; i < bars.length; i += 1) {
    let highest = -Infinity, lowest = Infinity;
    for (let j = i - period + 1; j <= i; j += 1) {
      if (toNum(bars[j].high, 0) > highest) highest = toNum(bars[j].high, 0);
      if (toNum(bars[j].low, 0) < lowest) lowest = toNum(bars[j].low, 0);
    }
    const t = toNum(bars[i].time, 0);
    upperData.push({ time: t, value: highest });
    midData.push({ time: t, value: (highest + lowest) / 2 });
    lowerData.push({ time: t, value: lowest });
  }
  return [
    { indicatorId: id, outputKey: "upper", label: "DC High", color: "rgba(248,113,113,0.5)", type: "line", pane: "main", lineWidth: 1, data: upperData },
    { indicatorId: id, outputKey: "mid",   label: "DC Mid",  color: "rgba(248,113,113,0.3)", type: "line", pane: "main", lineWidth: 1, data: midData },
    { indicatorId: id, outputKey: "lower", label: "DC Low",  color: "rgba(248,113,113,0.5)", type: "line", pane: "main", lineWidth: 1, data: lowerData },
  ];
}

// ─── Volume ───────────────────────────────────────────────────────────────────

function computeOBVIndicator(id, bars) {
  let obv = 0;
  const data = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i > 0) {
      if (toNum(bars[i].close, 0) > toNum(bars[i - 1].close, 0)) obv += toNum(bars[i].volume, 0);
      else if (toNum(bars[i].close, 0) < toNum(bars[i - 1].close, 0)) obv -= toNum(bars[i].volume, 0);
    }
    data.push({ time: toNum(bars[i].time, 0), value: obv });
  }
  return [{ indicatorId: id, outputKey: "obv", label: "OBV", color: "#38bdf8", type: "line", pane: "sub", lineWidth: 2, data }];
}

function computeVolSMAIndicator(id, bars, period) {
  const vols = bars.map((b) => toNum(b.volume, 0));
  const smaVol = sma(vols, period);
  const volData = [], smaData = [];
  for (let i = 0; i < bars.length; i += 1) {
    const t = toNum(bars[i].time, 0);
    volData.push({ time: t, value: vols[i] });
    pushIfFinite(smaData, t, smaVol[i]);
  }
  return [
    { indicatorId: id, outputKey: "vol", label: "Volume",  color: "rgba(96,165,250,0.5)", type: "histogram", pane: "sub", lineWidth: 1, data: volData },
    { indicatorId: id, outputKey: "sma", label: "Vol SMA", color: "#f5c842",               type: "line",      pane: "sub", lineWidth: 2, data: smaData },
  ];
}

function computeCVDIndicator(id, bars) {
  let cumDelta = 0;
  const data = [];
  for (let i = 0; i < bars.length; i += 1) {
    const range = Math.max(toNum(bars[i].high, 0) - toNum(bars[i].low, 0), 0.0001);
    const buyFrac = (toNum(bars[i].close, 0) - toNum(bars[i].low, 0)) / range;
    cumDelta += toNum(bars[i].volume, 0) * (2 * buyFrac - 1);
    data.push({ time: toNum(bars[i].time, 0), value: cumDelta });
  }
  return [{ indicatorId: id, outputKey: "cvd", label: "CVD", color: "#4ade80", type: "histogram", pane: "sub", lineWidth: 1, data }];
}

function computeCMFIndicator(id, bars, period) {
  const data = [];
  for (let i = period - 1; i < bars.length; i += 1) {
    let sumMfv = 0, sumVol = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const hl = toNum(bars[j].high, 0) - toNum(bars[j].low, 0);
      const mfm = hl > 0
        ? ((toNum(bars[j].close, 0) - toNum(bars[j].low, 0)) - (toNum(bars[j].high, 0) - toNum(bars[j].close, 0))) / hl
        : 0;
      sumMfv += mfm * toNum(bars[j].volume, 0);
      sumVol += toNum(bars[j].volume, 0);
    }
    data.push({ time: toNum(bars[i].time, 0), value: sumVol > 0 ? sumMfv / sumVol : 0 });
  }
  return [{ indicatorId: id, outputKey: "cmf", label: `CMF ${period}`, color: "#34d399", type: "histogram", pane: "sub", lineWidth: 1, data }];
}

// ─── Custom ───────────────────────────────────────────────────────────────────

function computeSupertrendIndicator(id, bars, period, mult) {
  let prevAtr = 0, prevUp = 0, prevDn = 0, trend = 1;
  const upData = [], dnData = [];
  for (let i = 0; i < bars.length; i += 1) {
    const hl2 = (toNum(bars[i].high, 0) + toNum(bars[i].low, 0)) / 2;
    const tr = i === 0
      ? toNum(bars[i].high, 0) - toNum(bars[i].low, 0)
      : Math.max(
          toNum(bars[i].high, 0) - toNum(bars[i].low, 0),
          Math.abs(toNum(bars[i].high, 0) - toNum(bars[i - 1].close, 0)),
          Math.abs(toNum(bars[i].low, 0) - toNum(bars[i - 1].close, 0)),
        );
    const atr = i === 0 ? tr : (prevAtr * (period - 1) + tr) / period;
    prevAtr = atr;
    const upper = hl2 + mult * atr;
    const lower = hl2 - mult * atr;
    const finalUp = (i === 0 || upper < prevUp || toNum(bars[i - 1].close, 0) < prevUp) ? upper : prevUp;
    const finalDn = (i === 0 || lower > prevDn || toNum(bars[i - 1].close, 0) > prevDn) ? lower : prevDn;
    if (trend === 1 && toNum(bars[i].close, 0) < finalUp) trend = -1;
    else if (trend === -1 && toNum(bars[i].close, 0) > finalDn) trend = 1;
    prevUp = finalUp;
    prevDn = finalDn;
    const t = toNum(bars[i].time, 0);
    if (trend === 1) upData.push({ time: t, value: finalDn });
    else dnData.push({ time: t, value: finalUp });
  }
  return [
    { indicatorId: id, outputKey: "up", label: "ST Bull", color: "#4ade80", type: "line", pane: "main", lineWidth: 2, data: upData },
    { indicatorId: id, outputKey: "dn", label: "ST Bear", color: "#f87171", type: "line", pane: "main", lineWidth: 2, data: dnData },
  ];
}

function computeMarketStructureIndicator(id, bars, lookback) {
  const hhData = [], llData = [];
  for (let i = lookback; i < bars.length; i += 1) {
    let isHH = true, isLL = true;
    for (let j = i - lookback; j < i; j += 1) {
      if (toNum(bars[i].high, 0) <= toNum(bars[j].high, 0)) isHH = false;
      if (toNum(bars[i].low, 0) >= toNum(bars[j].low, 0)) isLL = false;
    }
    const t = toNum(bars[i].time, 0);
    if (isHH) hhData.push({ time: t, value: toNum(bars[i].high, 0) });
    if (isLL) llData.push({ time: t, value: toNum(bars[i].low, 0) });
  }
  return [
    { indicatorId: id, outputKey: "hh", label: "HH", color: "#4ade80", type: "line", pane: "main", lineWidth: 1, data: hhData },
    { indicatorId: id, outputKey: "ll", label: "LL", color: "#f87171", type: "line", pane: "main", lineWidth: 1, data: llData },
  ];
}

// ─── Router ───────────────────────────────────────────────────────────────────

function computeFromActive(bars, active) {
  const outputs = [];
  const unknown = [];

  for (const indicator of active || []) {
    const id = String(indicator.id || "").toLowerCase();
    const p = indicator.params || {};

    // ── Trend ──
    if (id === "ema" || id === "ema9" || id === "ema21" || id === "ema50" || id === "ema200") {
      const defaults = { ema9: 9, ema21: 21, ema50: 50, ema200: 200 };
      const period = Math.max(2, Math.floor(toNum(p.period, defaults[id] || 20)));
      outputs.push(...computeEMAIndicator(id, bars, period, "#67e8a5"));
    } else if (id === "sma") {
      outputs.push(...computeSMAIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 20))), "#ffd166"));
    } else if (id === "wma") {
      outputs.push(...computeWMAIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 14))), "#c084fc"));
    } else if (id === "dema") {
      outputs.push(...computeDEMAIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 20))), "#2dd4bf"));
    } else if (id === "vwap") {
      outputs.push(...computeVWAPIndicator(id, bars));

    // ── Momentum ──
    } else if (id === "rsi") {
      outputs.push(...computeRSIIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 14)))));
    } else if (id === "macd") {
      const fast = Math.max(2, Math.floor(toNum(p.fast, 12)));
      const slow = Math.max(fast + 1, Math.floor(toNum(p.slow, 26)));
      outputs.push(...computeMACDIndicator(id, bars, fast, slow, Math.max(2, Math.floor(toNum(p.signal, 9)))));
    } else if (id === "stoch") {
      outputs.push(...computeStochIndicator(id, bars, Math.max(2, Math.floor(toNum(p.kPeriod, 14))), Math.max(1, Math.floor(toNum(p.dPeriod, 3)))));
    } else if (id === "cci") {
      outputs.push(...computeCCIIndicator(id, bars, Math.max(5, Math.floor(toNum(p.period, 20)))));
    } else if (id === "momentum") {
      outputs.push(...computeMomentumIndicator(id, bars, Math.max(1, Math.floor(toNum(p.period, 10)))));
    } else if (id === "roc") {
      outputs.push(...computeROCIndicator(id, bars, Math.max(1, Math.floor(toNum(p.period, 12)))));

    // ── Volatility ──
    } else if (id === "bb") {
      outputs.push(...computeBBIndicator(id, bars, Math.max(5, Math.floor(toNum(p.period, 20))), Math.max(0.5, toNum(p.mult, 2))));
    } else if (id === "atr") {
      outputs.push(...computeATRIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 14)))));
    } else if (id === "keltner") {
      outputs.push(...computeKeltnerIndicator(id, bars, Math.max(5, Math.floor(toNum(p.emaPeriod, 20))), Math.max(2, Math.floor(toNum(p.atrPeriod, 10))), Math.max(0.5, toNum(p.mult, 2))));
    } else if (id === "donchian") {
      outputs.push(...computeDonchianIndicator(id, bars, Math.max(5, Math.floor(toNum(p.period, 20)))));

    // ── Volume ──
    } else if (id === "obv") {
      outputs.push(...computeOBVIndicator(id, bars));
    } else if (id === "volsma") {
      outputs.push(...computeVolSMAIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 20)))));
    } else if (id === "cvd") {
      outputs.push(...computeCVDIndicator(id, bars));
    } else if (id === "cmf") {
      outputs.push(...computeCMFIndicator(id, bars, Math.max(5, Math.floor(toNum(p.period, 20)))));

    // ── Custom ──
    } else if (id === "supertrend") {
      outputs.push(...computeSupertrendIndicator(id, bars, Math.max(2, Math.floor(toNum(p.period, 10))), Math.max(0.5, toNum(p.mult, 3))));
    } else if (id === "market_structure") {
      outputs.push(...computeMarketStructureIndicator(id, bars, Math.max(2, Math.floor(toNum(p.lookback, 5)))));

    } else {
      unknown.push(id);
    }
  }

  if (unknown.length > 0) {
    throw new Error(`unsupported-indicators:${unknown.join(",")}`);
  }
  return outputs;
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (event) => {
  const payload = event.data || {};
  if (payload.type !== "compute") return;
  const id = String(payload.id || "");
  try {
    const bars = Array.isArray(payload.bars) ? payload.bars : [];
    const active = Array.isArray(payload.active) ? payload.active : [];
    const result = computeFromActive(bars, active);
    self.postMessage({ id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "worker-compute-error";
    self.postMessage({ id, result: [], error: message });
  }
};
