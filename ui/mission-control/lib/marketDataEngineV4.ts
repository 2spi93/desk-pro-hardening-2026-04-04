/**
 * MarketDataEngine V4 — Desk Quant / Prop Firm Grade
 *
 * Modules :
 *   1. Multi-feed tick aggregation (VWAP + best-price par venue)
 *   2. Latency tracking (tick-to-ingest)
 *   3. CVD — Cumulative Volume Delta (from trades stream)
 *   4. Orderbook Engine — depth imbalance temps réel (L2)
 *   5. Microstructure Engine — flow, aggressiveness, buy/sell pressure
 *   6. Event Engine — volume spike, spread widen, momentum flip
 *
 * Intégration : MarketDataBus instancie V4 et appelle :
 *   - v4.ingestTrade(trade)   → CVD + aggressiveness
 *   - v4.ingestDepth(delta)   → orderbook + imbalance
 *   - v4.ingestTick(price, venue, tsMs) → multi-feed + latency
 *   - v4.getSnapshot()        → MicrostructureSnapshot complet
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type VenueTick = {
  venue: string;
  price: number;
  size?: number;
  tsMs: number;
};

export type TradeInput = {
  price: number;
  size: number;
  side: "buy" | "sell" | string;
  tsMs?: number;
};

export type DepthRow = [number, number]; // [price, size]

export type DepthDelta = {
  bids?: DepthRow[];
  asks?: DepthRow[];
};

/**
 * Snapshot microstructure exporté vers l'UI / l'IA.
 * Compatible avec le champ `depth_imbalance` existant dans MarketMetric.
 */
export type MicrostructureSnapshot = {
  // Orderbook
  depthImbalance: number;      // [-1, +1] : +1 = bid dominant
  bidVolume: number;
  askVolume: number;
  spreadBps: number;
  bestBid: number;
  bestAsk: number;

  // CVD
  cvd: number;                 // cumulatif depuis résolution config
  cvdDelta: number;            // delta dernière fenêtre 30s
  cvdTrend: "rising" | "falling" | "flat";

  // Flow
  buyVolume30s: number;
  sellVolume30s: number;
  flowImbalance: number;       // [-1, +1]
  tradeAggressiveness: number; // [0, 1] — proportion trades agressifs

  // Multi-feed
  bestVenue: string;
  vwapPrice: number;
  venuePrices: Record<string, number>;
  priceDeviation: number;      // écart max entre venues (bps)

  // Latency
  avgLatencyMs: number;
  maxLatencyMs: number;
  latencyTier: "fast" | "normal" | "slow";  // <50ms | <200ms | >200ms

  // Events
  activeEvents: MarketEvent[];
  lastEventTs: number | null;
};

export type MarketEvent = {
  type: "VOLUME_SPIKE" | "SPREAD_WIDEN" | "MOMENTUM_FLIP" | "CVD_DIVERGENCE" | "LARGE_TRADE"
    | "LIQUIDATION" | "SPOOFING" | "ICEBERG";
  ts: number;
  value: number;
  description: string;
};

// ── Constantes ────────────────────────────────────────────────────────────────

const WINDOW_30S_MS     = 30_000;
const WINDOW_5M_MS      = 300_000;
const MAX_TRADES        = 500;
const MAX_EVENTS        = 20;
const MAX_LATENCY_SAMPLES = 100;
const SPREAD_SPIKE_BPS  = 50;   // événement si spread > 50bps
const VOLUME_SPIKE_MULT = 3;    // événement si volume > 3× moyenne
const LARGE_TRADE_BPS   = 0.1;  // 0.1% du prix = large trade
// Nouvelles détections V5
const LIQUIDATION_SIZE_MULT = 5;     // liqü = volume ×5+ moyenne + crossing bid/ask
const SPOOFING_CANCEL_RATIO = 0.7;   // 70% annulation de la taille affichée = spoofing potentiel
const ICEBERG_REPLENISH_MIN = 3;     // 3+ replenishments au même niveau = iceberg potentiel

// Historique orderbook pour détecter spoofing/iceberg

// ── Engine ────────────────────────────────────────────────────────────────────

export class MarketDataEngineV4 {
  // -- Orderbook L2
  private bids = new Map<number, number>(); // price → size
  private asks = new Map<number, number>();

  // -- CVD
  private cvd = 0;
  private trades: Array<{ price: number; size: number; side: string; tsMs: number }> = [];

  // -- Multi-feed
  private venueTicks = new Map<string, { price: number; tsMs: number }>();

  // -- Latency
  private latencySamples: number[] = [];

  // -- Events
  private events: MarketEvent[] = [];

  // -- Volume baseline (5m rolling pour spike detection)
  private recentVolumes: Array<{ vol: number; tsMs: number }> = [];

  // -- Spoofing/Iceberg detection : historique des niveaux orderbook
  // key = price.toFixed(4), value = historique des tailles observées
  private obLevelHistory = new Map<string, number[]>(); // price key → sizes[]

  // ── Ingestion Orderbook ────────────────────────────────────────────────────

  ingestDepth(delta: DepthDelta): void {
    const now = Date.now();
    if (delta.bids) {
      for (const [price, size] of delta.bids) {
        const previous = this.bids.get(price) ?? 0;
        if (size <= 0) {
          this.bids.delete(price);
        } else {
          this.bids.set(price, size);
        }
        // Spoofing / Iceberg analysis on significant levels
        if (previous > 0 || size > 0) {
          this._checkSpoofing(price, previous, size, now);
          if (size > 0) this._checkIceberg(price, size, now);
        }
      }
    }
    if (delta.asks) {
      for (const [price, size] of delta.asks) {
        const previous = this.asks.get(price) ?? 0;
        if (size <= 0) {
          this.asks.delete(price);
        } else {
          this.asks.set(price, size);
        }
        if (previous > 0 || size > 0) {
          this._checkSpoofing(price, previous, size, now);
          if (size > 0) this._checkIceberg(price, size, now);
        }
      }
    }
    this._checkSpreadEvent();
  }

  ingestDepthSnapshot(bids: DepthRow[], asks: DepthRow[]): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, s] of bids) if (s > 0) this.bids.set(p, s);
    for (const [p, s] of asks) if (s > 0) this.asks.set(p, s);
  }

  // ── Ingestion Trades ────────────────────────────────────────────────────────

  ingestTrade(trade: TradeInput): void {
    const tsMs = trade.tsMs ?? Date.now();
    const side = String(trade.side || "").toLowerCase();
    const size = Math.max(0, trade.size || 0);

    // CVD
    if (side === "buy") {
      this.cvd += size;
    } else if (side === "sell") {
      this.cvd -= size;
    }

    // Buffer de trades (fenêtre glissante 5m)
    this.trades.push({ price: trade.price, size, side, tsMs });
    if (this.trades.length > MAX_TRADES) {
      this.trades.shift();
    }

    // Volume rolling
    this.recentVolumes.push({ vol: size, tsMs });
    const cutoff5m = Date.now() - WINDOW_5M_MS;
    this.recentVolumes = this.recentVolumes.filter((v) => v.tsMs > cutoff5m);

    // Large trade event
    const { bestBid, bestAsk } = this._getBestPrices();
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : trade.price;
    const largeThreshold = mid * LARGE_TRADE_BPS / 100;
    if (mid > 0 && size * trade.price > largeThreshold * mid) {
      this._addEvent({
        type: "LARGE_TRADE",
        ts: tsMs,
        value: size * trade.price,
        description: `Large ${side} ${(size).toFixed(4)} @ ${trade.price.toFixed(2)}`,
      });
    }

    this._checkVolumeSpike(size, tsMs);
    this._checkLiquidation(size, side, trade.price, tsMs);
    this._checkMomentumFlip();
  }

  ingestTradeFast(price: number, size: number, sideFlag: number, tsMs: number): void {
    this.ingestTrade({
      price,
      size,
      side: sideFlag > 0 ? "sell" : "buy",
      tsMs,
    });
  }

  // ── Ingestion Tick (multi-feed) ─────────────────────────────────────────────

  ingestTick(tick: VenueTick): void {
    const ingestMs = Date.now();
    const latency = ingestMs - tick.tsMs;

    if (Number.isFinite(latency) && latency >= 0 && latency < 10_000) {
      this.latencySamples.push(latency);
      if (this.latencySamples.length > MAX_LATENCY_SAMPLES) {
        this.latencySamples.shift();
      }
    }

    if (tick.price > 0) {
      this.venueTicks.set(tick.venue, { price: tick.price, tsMs: tick.tsMs });
      // Pruner les ticks stales (>5s)
      const cutoff = Date.now() - 5_000;
      for (const [venue, entry] of this.venueTicks.entries()) {
        if (entry.tsMs < cutoff) this.venueTicks.delete(venue);
      }
    }

    this._checkMomentumFlip();
  }

  ingestTickFast(venue: string, price: number, tsMs: number, size?: number): void {
    this.ingestTick({ venue, price, tsMs, size });
  }

  // ── Reset (changement config) ────────────────────────────────────────────────

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.cvd = 0;
    this.trades = [];
    this.venueTicks.clear();
    this.latencySamples = [];
    this.events = [];
    this.recentVolumes = [];
    this.obLevelHistory.clear();
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────

  getSnapshot(): MicrostructureSnapshot {
    const now = Date.now();
    const cutoff30s = now - WINDOW_30S_MS;

    // Orderbook
    const bidVol = this._sumDepth(this.bids, 20);
    const askVol = this._sumDepth(this.asks, 20);
    const totalDepth = bidVol + askVol;
    const depthImbalance = totalDepth > 0 ? (bidVol - askVol) / totalDepth : 0;
    const { bestBid, bestAsk } = this._getBestPrices();
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;
    const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

    // CVD
    const cvdWindow = this.trades.filter((t) => t.tsMs > cutoff30s);
    const cvdDelta = cvdWindow.reduce((acc, t) => {
      return acc + (t.side === "buy" ? t.size : t.side === "sell" ? -t.size : 0);
    }, 0);
    const cvdTrend: MicrostructureSnapshot["cvdTrend"] =
      Math.abs(cvdDelta) < 0.001 ? "flat" : cvdDelta > 0 ? "rising" : "falling";

    // Flow 30s
    const recentTrades = this.trades.filter((t) => t.tsMs > cutoff30s);
    const buyVol30s = recentTrades.filter((t) => t.side === "buy").reduce((s, t) => s + t.size, 0);
    const sellVol30s = recentTrades.filter((t) => t.side === "sell").reduce((s, t) => s + t.size, 0);
    const flowTotal = buyVol30s + sellVol30s;
    const flowImbalance = flowTotal > 0 ? (buyVol30s - sellVol30s) / flowTotal : 0;

    // Aggressiveness : trades qui croisent le spread (buy >= ask ou sell <= bid)
    const aggressiveTrades = recentTrades.filter((t) => {
      if (bestAsk > 0 && bestBid > 0) {
        return (t.side === "buy" && t.price >= bestAsk) || (t.side === "sell" && t.price <= bestBid);
      }
      return false;
    }).length;
    const tradeAggressiveness = recentTrades.length > 0 ? aggressiveTrades / recentTrades.length : 0;

    // Multi-feed VWAP + best venue
    const liveVenues = [...this.venueTicks.entries()].filter(([, v]) => v.price > 0);
    let vwapNum = 0;
    let vwapDen = 0;
    let bestVenuePrice = 0;
    let bestVenueName = "-";
    for (const [venue, entry] of liveVenues) {
      vwapNum += entry.price;
      vwapDen += 1;
      if (bestBid > 0) {
        const spread = Math.abs(entry.price - bestBid) / bestBid;
        if (bestVenuePrice === 0 || spread < Math.abs(bestVenuePrice - bestBid) / bestBid) {
          bestVenuePrice = entry.price;
          bestVenueName = venue;
        }
      } else {
        bestVenueName = venue;
        bestVenuePrice = entry.price;
      }
    }
    const vwapPrice = vwapDen > 0 ? vwapNum / vwapDen : 0;
    const prices = liveVenues.map(([, v]) => v.price);
    const priceDeviation = prices.length >= 2 && vwapPrice > 0
      ? ((Math.max(...prices) - Math.min(...prices)) / vwapPrice) * 10_000
      : 0;
    const venuePrices = Object.fromEntries(liveVenues.map(([v, e]) => [v, e.price]));

    // Latency
    const avgLatencyMs = this.latencySamples.length > 0
      ? this.latencySamples.reduce((s, l) => s + l, 0) / this.latencySamples.length
      : 0;
    const maxLatencyMs = this.latencySamples.length > 0
      ? Math.max(...this.latencySamples)
      : 0;
    const latencyTier: MicrostructureSnapshot["latencyTier"] =
      avgLatencyMs < 50 ? "fast" : avgLatencyMs < 200 ? "normal" : "slow";

    // Events actifs (dernières 60s)
    const activeEvents = this.events
      .filter((e) => now - e.ts < 60_000)
      .slice(-5);

    return {
      depthImbalance,
      bidVolume: bidVol,
      askVolume: askVol,
      spreadBps,
      bestBid,
      bestAsk,
      cvd: this.cvd,
      cvdDelta,
      cvdTrend,
      buyVolume30s: buyVol30s,
      sellVolume30s: sellVol30s,
      flowImbalance,
      tradeAggressiveness,
      bestVenue: bestVenueName,
      vwapPrice,
      venuePrices,
      priceDeviation,
      avgLatencyMs,
      maxLatencyMs,
      latencyTier,
      activeEvents,
      lastEventTs: this.events.length > 0 ? this.events[this.events.length - 1].ts : null,
    };
  }

  // ── Helpers privés ────────────────────────────────────────────────────────────

  private _sumDepth(side: Map<number, number>, levels: number): number {
    const sorted = [...side.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(0, levels);
    return sorted.reduce((s, [, size]) => s + size, 0);
  }

  private _getBestPrices(): { bestBid: number; bestAsk: number } {
    const bestBid = this.bids.size > 0 ? Math.max(...this.bids.keys()) : 0;
    const bestAsk = this.asks.size > 0 ? Math.min(...this.asks.keys()) : 0;
    return { bestBid, bestAsk };
  }

  private _addEvent(event: MarketEvent): void {
    // Dédupliquer : pas 2 événements identiques en <5s
    const last = [...this.events].reverse().find((e) => e.type === event.type);
    if (last && event.ts - last.ts < 5_000) return;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }

  private _checkSpreadEvent(): void {
    const { bestBid, bestAsk } = this._getBestPrices();
    if (bestBid <= 0 || bestAsk <= 0) return;
    const mid = (bestBid + bestAsk) / 2;
    const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;
    if (spreadBps > SPREAD_SPIKE_BPS) {
      this._addEvent({
        type: "SPREAD_WIDEN",
        ts: Date.now(),
        value: spreadBps,
        description: `Spread ${spreadBps.toFixed(1)}bps — liquidité réduite`,
      });
    }
  }

  private _checkVolumeSpike(size: number, tsMs: number): void {
    if (this.recentVolumes.length < 10) return;
    const cutoff = tsMs - WINDOW_5M_MS;
    const window = this.recentVolumes.filter((v) => v.tsMs > cutoff);
    const avgVol = window.reduce((s, v) => s + v.vol, 0) / window.length;
    if (avgVol > 0 && size > avgVol * VOLUME_SPIKE_MULT) {
      this._addEvent({
        type: "VOLUME_SPIKE",
        ts: tsMs,
        value: size / avgVol,
        description: `Volume ×${(size / avgVol).toFixed(1)} vs moyenne`,
      });
    }
  }

  private _checkMomentumFlip(): void {
    if (this.trades.length < 10) return;
    const now = Date.now();
    const recent5 = this.trades.slice(-5);
    const prev5   = this.trades.slice(-10, -5);
    const recentBuy  = recent5.filter((t) => t.side === "buy").length;
    const prevBuy    = prev5  .filter((t) => t.side === "buy").length;
    // Flip si side dominante inverse
    if ((recentBuy >= 4 && prevBuy <= 1) || (recentBuy <= 1 && prevBuy >= 4)) {
      const dir = recentBuy >= 4 ? "BUY" : "SELL";
      this._addEvent({
        type: "MOMENTUM_FLIP",
        ts: now,
        value: recentBuy,
        description: `Flow flip → ${dir} dominant`,
      });
    }
  }

  /**
   * LIQUIDATION DETECT
   * Heuristique : trade anormalement large + crossing spread agressif
   * (taker achète/vend sans négociation → liquidation forcée)
   */
  private _checkLiquidation(size: number, side: string, price: number, tsMs: number): void {
    if (this.recentVolumes.length < 10) return;
    const cutoff = tsMs - WINDOW_5M_MS;
    const window = this.recentVolumes.filter((v) => v.tsMs > cutoff);
    const avgVol = window.reduce((s, v) => s + v.vol, 0) / Math.max(1, window.length);
    if (size < avgVol * LIQUIDATION_SIZE_MULT) return;

    const { bestBid, bestAsk } = this._getBestPrices();
    const isForcedCross =
      (side === "buy" && bestAsk > 0 && price >= bestAsk * 1.001) ||
      (side === "sell" && bestBid > 0 && price <= bestBid * 0.999);

    if (isForcedCross) {
      this._addEvent({
        type: "LIQUIDATION",
        ts: tsMs,
        value: size,
        description: `Liquidation probable ${side.toUpperCase()} ×${(size / avgVol).toFixed(1)} avg — cross at ${price.toFixed(2)}`,
      });
    }
  }

  /**
   * SPOOFING DETECT
   * Heuristique : niveau orderbook avec grande taille qui disparaît rapidement
   * sans consommation (annulation > SPOOFING_CANCEL_RATIO de la taille affichée)
   */
  _checkSpoofing(price: number, previousSize: number, newSize: number, tsMs: number): void {
    if (previousSize <= 0) return;
    const cancellationRatio = Math.max(0, (previousSize - newSize) / previousSize);
    if (cancellationRatio >= SPOOFING_CANCEL_RATIO && newSize === 0) {
      const priceKey = price.toFixed(4);
      const history = this.obLevelHistory.get(priceKey) ?? [];
      // Spoofing = apparition + disparition rapide sans trade
      if (history.length >= 2 && history[history.length - 1] > 0) {
        this._addEvent({
          type: "SPOOFING",
          ts: tsMs,
          value: cancellationRatio,
          description: `Spoofing potentiel @ ${price.toFixed(2)} — ${(cancellationRatio * 100).toFixed(0)}% annulé sans consommation`,
        });
      }
    }
    // Mettre à jour l'historique de ce niveau
    const priceKey = price.toFixed(4);
    const history = this.obLevelHistory.get(priceKey) ?? [];
    history.push(newSize);
    if (history.length > 10) history.shift();
    this.obLevelHistory.set(priceKey, history);
  }

  /**
   * ICEBERG DETECT
   * Heuristique : niveau orderbook qui se "rechargé" plusieurs fois au même prix
   * après consommation partielle → ordre caché (iceberg)
   */
  _checkIceberg(price: number, newSize: number, tsMs: number): void {
    const priceKey = price.toFixed(4);
    const history = this.obLevelHistory.get(priceKey) ?? [];

    if (history.length >= 2) {
      const prev = history[history.length - 1];
      // Rechargement = taille augmente après avoir été partiellement consommée
      if (prev > 0 && newSize > prev * 0.8 && newSize > 0) {
        // Compter les rechargements
        let replenishments = 0;
        for (let i = 1; i < history.length; i++) {
          if (history[i] > history[i - 1] * 0.7) replenishments++;
        }
        if (replenishments >= ICEBERG_REPLENISH_MIN) {
          this._addEvent({
            type: "ICEBERG",
            ts: tsMs,
            value: newSize,
            description: `Iceberg potentiel @ ${price.toFixed(2)} — ${replenishments} rechargements détectés`,
          });
        }
      }
    }
  }
}

