/**
 * Candle transform functions.
 *
 * Transforms convert standard OHLCV candles into alternative representations:
 *   heikinAshi  — smoothed candles that reduce noise
 *   renko       — brick charts that filter minor movements
 *   lineBreak   — three-line break chart
 *   pointFigure — point and figure (P&F) columns
 *
 * All transforms return arrays of { time, open, high, low, close, volume }
 * with the same shape as the input BarData.
 */

export type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// ════════════════════════════════════════════════════════════
// HEIKIN ASHI
// ════════════════════════════════════════════════════════════

/**
 * Classic Heikin Ashi transform.
 *
 * HA_Close = (Open + High + Low + Close) / 4
 * HA_Open  = (prev_HA_Open + prev_HA_Close) / 2  [seed: (Open + Close) / 2]
 * HA_High  = max(High, HA_Open, HA_Close)
 * HA_Low   = min(Low,  HA_Open, HA_Close)
 */
export function heikinAshi(bars: Bar[]): Bar[] {
  if (bars.length === 0) return [];

  const result: Bar[] = [];
  let prevHaOpen = (bars[0].open + bars[0].close) / 2;
  let prevHaClose = (bars[0].open + bars[0].high + bars[0].low + bars[0].close) / 4;

  result.push({
    time: bars[0].time,
    open: prevHaOpen,
    high: Math.max(bars[0].high, prevHaOpen, prevHaClose),
    low: Math.min(bars[0].low, prevHaOpen, prevHaClose),
    close: prevHaClose,
    volume: bars[0].volume,
  });

  for (let i = 1; i < bars.length; i++) {
    const haClose = (bars[i].open + bars[i].high + bars[i].low + bars[i].close) / 4;
    const haOpen = (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(bars[i].high, haOpen, haClose);
    const haLow = Math.min(bars[i].low, haOpen, haClose);

    result.push({
      time: bars[i].time,
      open: haOpen,
      high: haHigh,
      low: haLow,
      close: haClose,
      volume: bars[i].volume,
    });

    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }

  return result;
}

// ════════════════════════════════════════════════════════════
// RENKO
// ════════════════════════════════════════════════════════════

export type RenkoOptions = {
  brickSize: number;
  /** "atr" to auto-size bricks, otherwise a fixed price value */
  method?: "fixed" | "atr";
  atrPeriod?: number;
};

/**
 * Build Renko bricks from a series of OHLCV bars.
 * Uses closing prices to determine brick boundaries.
 *
 * Each output bar has:
 *   open/close = brick boundaries
 *   high = top of wick (= max of open, close)
 *   low  = bottom of wick (= min of open, close)
 *   time = time of the original bar that completed the brick
 */
export function renko(bars: Bar[], options: RenkoOptions): Bar[] {
  if (bars.length < 2) return [];

  let brickSize = options.brickSize ?? 1;
  if (brickSize <= 0) brickSize = 1;

  if (options.method === "atr") {
    const period = Math.max(2, options.atrPeriod ?? 14);
    brickSize = computeAtrBrickSize(bars, period);
  }

  const result: Bar[] = [];
  let brickOpen = Math.floor(bars[0].close / brickSize) * brickSize;
  let totalVolume = bars[0].volume;

  for (let i = 1; i < bars.length; i++) {
    const close = bars[i].close;
    totalVolume += bars[i].volume;

    // How many bricks up or down?
    const bricksUp = Math.floor((close - brickOpen) / brickSize);
    const bricksDown = Math.floor((brickOpen - close) / brickSize);

    if (bricksUp >= 1) {
      for (let b = 0; b < bricksUp; b++) {
        const lo = brickOpen + b * brickSize;
        const hi = lo + brickSize;
        result.push({
          time: bars[i].time,
          open: lo,
          high: hi,
          low: lo,
          close: hi,
          volume: totalVolume / bricksUp,
        });
      }
      brickOpen = brickOpen + bricksUp * brickSize;
      totalVolume = 0;
    } else if (bricksDown >= 1) {
      for (let b = 0; b < bricksDown; b++) {
        const hi = brickOpen - b * brickSize;
        const lo = hi - brickSize;
        result.push({
          time: bars[i].time,
          open: hi,
          high: hi,
          low: lo,
          close: lo,
          volume: totalVolume / bricksDown,
        });
      }
      brickOpen = brickOpen - bricksDown * brickSize;
      totalVolume = 0;
    }
  }

  return result;
}

function computeAtrBrickSize(bars: Bar[], period: number): number {
  let atr = 0;
  for (let i = 1; i < Math.min(period + 1, bars.length); i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    atr += tr / period;
  }
  return Math.max(0.0001, atr);
}

// ════════════════════════════════════════════════════════════
// THREE-LINE BREAK
// ════════════════════════════════════════════════════════════

/**
 * Three-Line Break chart.
 * A new line is added only when price closes beyond the highest
 * (uptrend) or lowest (downtrend) of the previous N lines.
 */
export function threeLineBreak(bars: Bar[], lines = 3): Bar[] {
  if (bars.length < lines + 1) return [];

  const result: Bar[] = [];
  const lineHistory: Bar[] = [];

  const addLine = (time: number, open: number, close: number, volume: number) => {
    const bar: Bar = {
      time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume,
    };
    result.push(bar);
    lineHistory.push(bar);
    if (lineHistory.length > lines + 2) {
      lineHistory.shift();
    }
  };

  // Seed with first bar
  addLine(bars[0].time, bars[0].open, bars[0].close, bars[0].volume);

  for (let i = 1; i < bars.length; i++) {
    const price = bars[i].close;
    const lastN = lineHistory.slice(-Math.min(lines, lineHistory.length));
    if (lastN.length === 0) continue;

    const highN = Math.max(...lastN.map((b) => b.close));
    const lowN = Math.min(...lastN.map((b) => b.close));
    const prevClose = lineHistory[lineHistory.length - 1].close;
    const prevOpen = lineHistory[lineHistory.length - 1].open;
    const prevBull = prevClose > prevOpen;

    if ((prevBull && price > highN) || (!prevBull && price > highN)) {
      addLine(bars[i].time, prevClose, price, bars[i].volume);
    } else if ((!prevBull && price < lowN) || (prevBull && price < lowN)) {
      addLine(bars[i].time, prevClose, price, bars[i].volume);
    }
  }

  return result;
}

// ════════════════════════════════════════════════════════════
// KAGI
// ════════════════════════════════════════════════════════════

export function kagi(bars: Bar[], reversalAmount: number): Bar[] {
  if (bars.length < 2) return [];

  const result: Bar[] = [];
  let direction: "up" | "down" = bars[1].close > bars[0].close ? "up" : "down";
  let kaginPrice = bars[0].close;
  let prevTurn = bars[0].close;
  let segOpen = bars[0].time;

  for (let i = 1; i < bars.length; i++) {
    const price = bars[i].close;
    const rev = Math.max(0.0001, reversalAmount);

    if (direction === "up" && price <= kaginPrice - rev) {
      result.push({ time: bars[i].time, open: prevTurn, high: kaginPrice, low: price, close: kaginPrice, volume: bars[i].volume });
      prevTurn = kaginPrice;
      kaginPrice = price;
      direction = "down";
      segOpen = bars[i].time;
    } else if (direction === "down" && price >= kaginPrice + rev) {
      result.push({ time: bars[i].time, open: prevTurn, high: price, low: kaginPrice, close: price, volume: bars[i].volume });
      prevTurn = kaginPrice;
      kaginPrice = price;
      direction = "up";
      segOpen = bars[i].time;
    } else {
      kaginPrice = direction === "up" ? Math.max(kaginPrice, price) : Math.min(kaginPrice, price);
    }
  }

  // Flush final segment
  if (result.length > 0 || bars.length > 1) {
    result.push({
      time: bars[bars.length - 1].time,
      open: prevTurn,
      high: Math.max(prevTurn, kaginPrice),
      low: Math.min(prevTurn, kaginPrice),
      close: kaginPrice,
      volume: 0,
    });
  }

  return result;
}

// ════════════════════════════════════════════════════════════
// VOLUME PROFILE
// ════════════════════════════════════════════════════════════

export type VolumeProfileBin = {
  priceHigh: number;
  priceLow: number;
  priceMid: number;
  totalVol: number;
  buyVol: number;
  sellVol: number;
  /** 0–1 relative to the highest bin */
  pct: number;
  isPoc: boolean; // Point of Control
};

/**
 * Compute a volume profile from OHLCV bars.
 * Distributes each bar's volume across price levels based on bar range.
 */
export function volumeProfile(bars: Bar[], numBins = 24): VolumeProfileBin[] {
  if (bars.length === 0) return [];

  const allHigh = Math.max(...bars.map((b) => b.high));
  const allLow = Math.min(...bars.map((b) => b.low));
  const range = Math.max(allHigh - allLow, 0.0001);
  const binSize = range / numBins;

  const bins: Array<{ total: number; buy: number; sell: number }> = Array.from(
    { length: numBins },
    () => ({ total: 0, buy: 0, sell: 0 }),
  );

  for (const bar of bars) {
    const barRange = Math.max(bar.high - bar.low, 0.0001);
    // Approximate buy/sell split from candle body + direction
    const buyFraction = Math.max(0, Math.min(1, (bar.close - bar.low) / barRange));

    // How many bins does this bar span?
    const startBin = Math.max(0, Math.floor((bar.low - allLow) / binSize));
    const endBin = Math.min(numBins - 1, Math.floor((bar.high - allLow) / binSize));

    for (let b = startBin; b <= endBin; b++) {
      const binFraction = 1 / Math.max(1, endBin - startBin + 1);
      const vol = bar.volume * binFraction;
      bins[b].total += vol;
      bins[b].buy += vol * buyFraction;
      bins[b].sell += vol * (1 - buyFraction);
    }
  }

  const maxVol = Math.max(...bins.map((b) => b.total), 1);
  const pocIndex = bins.reduce((best, b, i) => (b.total > bins[best].total ? i : best), 0);

  return bins.map((b, i) => ({
    priceHigh: allLow + (i + 1) * binSize,
    priceLow: allLow + i * binSize,
    priceMid: allLow + (i + 0.5) * binSize,
    totalVol: b.total,
    buyVol: b.buy,
    sellVol: b.sell,
    pct: b.total / maxVol,
    isPoc: i === pocIndex,
  }));
}
