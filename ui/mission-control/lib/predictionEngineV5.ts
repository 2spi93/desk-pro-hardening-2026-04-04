// ── Perception Engine V5 — Predictive Core ──────────────────────────────────
// Pure function: prend candles + DOM + heatmap → prediction anticipative.
// Aucun side-effect, aucun état global. Utilisable dans useMemo sans risque.

export type DirectionV5 = "LONG" | "SHORT" | "WAIT";
export type SignalV5 = "BREAKOUT" | "EXHAUSTION" | "ABSORPTION" | "COMPRESSION" | "NONE";
export type TimingV5 = "imminent" | "building" | "weak";
export type DriftV5 = "rising" | "falling" | "stable";

export type PredictionV5 = {
  direction: DirectionV5;
  probability: number;         // 0-100
  trigger: number | null;       // prix déclencheur
  invalidation: number | null;  // prix d'invalidation (stop)
  timing: TimingV5;
  signal: SignalV5;
  confluenceCount: number;      // 0-5 signaux alignés
  confidenceDrift: DriftV5;     // vitesse de montée/descente de la confiance
  zone: { entry: number; liquidity: number; stop: number } | null;
  reasons: string[];
};

type CandleIn = { open: number; high: number; low: number; close: number; volume: number };
type DomIn    = { side: "bid" | "ask"; price: number; size: number; intensity: number };

export function computePredictionV5(
  candles: CandleIn[],
  domLevels: DomIn[],
  heatmapLevels: DomIn[],
  aiConfidencePct: number,
  prevConfidencePct: number,
): PredictionV5 {
  const EMPTY: PredictionV5 = {
    direction: "WAIT", probability: 0, trigger: null, invalidation: null,
    timing: "weak", signal: "NONE", confluenceCount: 0,
    confidenceDrift: "stable", zone: null, reasons: [],
  };

  if (candles.length < 10) return EMPTY;

  const last   = candles[candles.length - 1];
  const last5  = candles.slice(-5);
  const last10 = candles.slice(-10);
  const last20 = candles.slice(-20);
  const price  = last.close;

  // ── 1. ATR approximation ───────────────────────────────────────────────────
  const atr = last20.reduce((s, c) => s + (c.high - c.low), 0) / Math.max(1, last20.length);

  // ── 2. Delta momentum (weighted by body/range ratio) ───────────────────────
  const deltaScore = last10.reduce((s, c) => {
    const body  = c.close - c.open;
    const range = Math.max(1e-9, c.high - c.low);
    return s + (body / range) * Math.min(1, c.volume / Math.max(1, last10.reduce((a, x) => a + x.volume, 0) / 10));
  }, 0);
  const normDelta = Math.max(-1, Math.min(1, deltaScore / 4));

  // ── 3. Volatility compression (squeeze avant explosion) ────────────────────
  const avgBody5  = last5.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 5;
  const avgBody20 = last20.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / Math.max(1, last20.length);
  const isCompressed = avgBody5 < avgBody20 * 0.52 && atr > 0;

  // ── 4. Exhaustion detection (price monte + volume baisse + delta faible) ───
  const vol5  = last5.reduce((s, c) => s + c.volume, 0) / 5;
  const refCand5 = candles[candles.length - 6];
  const vol20avg = last20.reduce((s, c) => s + c.volume, 0) / Math.max(1, last20.length);
  const volDropping = vol5 < vol20avg * 0.72;
  const priceUp5   = refCand5 ? last.close > refCand5.close : false;
  const priceDown5 = refCand5 ? last.close < refCand5.close : false;
  const exhaustBull = priceUp5  && volDropping && normDelta < 0.08;
  const exhaustBear = priceDown5 && volDropping && normDelta > -0.08;

  // ── 5. DOM imbalance ────────────────────────────────────────────────────────
  const bids   = domLevels.filter(l => l.side === "bid");
  const asks   = domLevels.filter(l => l.side === "ask");
  const bidVol = bids.reduce((s, l) => s + l.size, 0);
  const askVol = asks.reduce((s, l) => s + l.size, 0);
  const domTotal    = Math.max(1, bidVol + askVol);
  const domImbalance = (bidVol - askVol) / domTotal; // >0 = haussier

  // ── 6. Liquidity proximity (mur de liquidité proche) ──────────────────────
  const nearLiqLevels = heatmapLevels.filter(l => {
    const dist = Math.abs(l.price - price) / Math.max(1, price);
    return dist < 0.003 && l.intensity > 0.6;
  });
  const nearLiquidity = nearLiqLevels.length > 0;
  const closestWall = heatmapLevels
    .filter(l => l.intensity > 0.6)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))[0] ?? null;

  // ── 7. Absorption (petits corps près d'un niveau fort) ────────────────────
  const bodyRange = Math.max(1e-8, Math.max(...last5.map(c => c.high)) - Math.min(...last5.map(c => c.low)));
  const avgBodyLast5 = last5.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 5;
  const isAbsorbed = nearLiquidity && avgBodyLast5 < bodyRange * 0.28;

  // ── Confluence scoring ─────────────────────────────────────────────────────
  const bullFactors: [boolean, string][] = [
    [normDelta > 0.22,               "delta bull"],
    [domImbalance > 0.18,            "DOM bids stacked"],
    [isCompressed && !exhaustBull,   "volatility squeeze"],
    [isAbsorbed && domImbalance > 0, "absorption → long"],
    [exhaustBear,                    "bear exhaustion"],
  ];
  const bearFactors: [boolean, string][] = [
    [normDelta < -0.22,              "delta bear"],
    [domImbalance < -0.18,           "DOM asks stacked"],
    [isCompressed && !exhaustBear,   "volatility squeeze"],
    [isAbsorbed && domImbalance < 0, "absorption → short"],
    [exhaustBull,                    "bull exhaustion"],
  ];

  const bullCount   = bullFactors.filter(([v]) => v).length;
  const bearCount   = bearFactors.filter(([v]) => v).length;
  const bullReasons = bullFactors.filter(([v]) => v).map(([, r]) => r);
  const bearReasons = bearFactors.filter(([v]) => v).map(([, r]) => r);

  let direction: DirectionV5 = "WAIT";
  let confluenceCount = 0;
  let signal: SignalV5 = "NONE";
  let reasons: string[] = [];

  if (bullCount > bearCount && bullCount >= 2) {
    direction      = "LONG";
    confluenceCount = bullCount;
    reasons        = bullReasons;
    signal         = exhaustBear ? "EXHAUSTION" : isAbsorbed ? "ABSORPTION" : isCompressed ? "COMPRESSION" : "BREAKOUT";
  } else if (bearCount > bullCount && bearCount >= 2) {
    direction      = "SHORT";
    confluenceCount = bearCount;
    reasons        = bearReasons;
    signal         = exhaustBull ? "EXHAUSTION" : isAbsorbed ? "ABSORPTION" : isCompressed ? "COMPRESSION" : "BREAKOUT";
  } else {
    confluenceCount = Math.max(bullCount, bearCount);
    reasons        = bullCount >= bearCount ? bullReasons : bearReasons;
  }

  // ── Probabilité (IA base + bonus confluence) ───────────────────────────────
  const bonus = confluenceCount * 5;
  const malus = direction === "WAIT" ? 12 : 0;
  const probability = Math.max(10, Math.min(94, aiConfidencePct + bonus - malus));

  // ── Timing ─────────────────────────────────────────────────────────────────
  const timing: TimingV5 =
    nearLiquidity && confluenceCount >= 3 ? "imminent" :
    confluenceCount >= 2                  ? "building"  : "weak";

  // ── Drift de confiance ─────────────────────────────────────────────────────
  const confidenceDrift: DriftV5 =
    aiConfidencePct > prevConfidencePct + 6 ? "rising"  :
    aiConfidencePct < prevConfidencePct - 6 ? "falling" : "stable";

  // ── Trigger + Invalidation ─────────────────────────────────────────────────
  let trigger: number | null = null;
  let invalidation: number | null = null;

  if (direction === "LONG") {
    trigger      = closestWall?.side === "ask" ? closestWall.price : price + atr * 0.6;
    invalidation = price - atr * 1.3;
  } else if (direction === "SHORT") {
    trigger      = closestWall?.side === "bid" ? closestWall.price : price - atr * 0.6;
    invalidation = price + atr * 1.3;
  }

  // ── Zone d'anticipation ────────────────────────────────────────────────────
  const zone = direction !== "WAIT" && trigger !== null ? {
    entry:     trigger,
    liquidity: direction === "LONG" ? trigger + atr * 1.8 : trigger - atr * 1.8,
    stop:      invalidation ?? (direction === "LONG" ? price - atr * 1.5 : price + atr * 1.5),
  } : null;

  return { direction, probability, trigger, invalidation, timing, signal, confluenceCount, confidenceDrift, zone, reasons };
}
