/**
 * CandleEngineV5 — Build OHLCV candles directly from raw trade stream.
 *
 * Game-changer : zéro dépendance sur l'API OHLCV de l'exchange.
 * Reconstruction fidèle, tick-level, identique au pipeline TradingView pro.
 *
 * Rôles :
 *   1. Reconstruction en temps réel desde les trades WS
 *   2. Détection de trous (gaps) dans une série OHLCV existante
 *   3. Comblement des trous avec les candles reconstruites
 *   4. Compensation de latence (shift homogène des timestamps)
 *   5. Double-buffer : swapBuffers() élimine le jitter UI
 */

import type { NormalizedOhlcvBar } from "./ohlcvIntegrity";
import { timeframeToMs, alignToTimeSlot } from "./ohlcvDataEngine";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TradeForCandle = {
  price: number;
  size: number;
  side?: "buy" | "sell" | string;
  tsMs: number;
  exchangeTs?: number; // timestamp exchange (avant latence réseau)
};

export type GapRange = {
  startMs: number;   // début du premier slot manquant
  endMs: number;     // début du slot suivant existant
  missingSlots: number;
};

// ── Engine ────────────────────────────────────────────────────────────────────

export class CandleEngineV5 {
  private timeframe: string;
  private tfMs: number;
  private latencyOffsetMs = 0;

  // Candles courantes construites depuis trades
  private candles = new Map<number, NormalizedOhlcvBar>(); // slotMs → bar

  // Double buffer
  private backBuffer: NormalizedOhlcvBar[] = [];
  private frontBuffer: NormalizedOhlcvBar[] = [];

  // Buffer de trades récents (fenêtre glissante 10 min)
  private recentTrades: TradeForCandle[] = [];
  private readonly TRADE_BUFFER_MS = 600_000;

  constructor(timeframe: string) {
    this.timeframe = timeframe;
    this.tfMs = timeframeToMs(timeframe);
  }

  // ── Ingestion ──────────────────────────────────────────────────────────────

  /**
   * Ingère un trade et met à jour (ou crée) la candle du slot correspondant.
   * Retourne la candle modifiée.
   */
  ingestTrade(trade: TradeForCandle): NormalizedOhlcvBar {
    const ts = (trade.exchangeTs ?? trade.tsMs) + this.latencyOffsetMs;
    const slotMs = alignToTimeSlot(ts, this.tfMs);
    const slotTs = new Date(slotMs).toISOString();

    const existing = this.candles.get(slotMs);
    let candle: NormalizedOhlcvBar;

    if (!existing) {
      candle = {
        t: slotTs,
        o: trade.price,
        h: trade.price,
        l: trade.price,
        c: trade.price,
        v: trade.size,
        tf: this.timeframe,
        seq: slotMs,
      };
    } else {
      candle = {
        t: slotTs,
        o: existing.o,
        h: Math.max(existing.h, trade.price),
        l: Math.min(existing.l, trade.price),
        c: trade.price,
        v: existing.v + trade.size,
        tf: existing.tf,
        seq: existing.seq,
      };
    }

    this.candles.set(slotMs, candle);

    // Buffer rolling pour diagnostics
    this.recentTrades.push(trade);
    const cutoff = Date.now() - this.TRADE_BUFFER_MS;
    if (this.recentTrades.length > 2000) {
      this.recentTrades = this.recentTrades.filter((t) => t.tsMs > cutoff);
    }

    return candle;
  }

  ingestTradeFast(price: number, size: number, sideFlag: number, tsMs: number, exchangeTs?: number): NormalizedOhlcvBar {
    return this.ingestTrade({
      price,
      size,
      side: sideFlag > 0 ? "sell" : "buy",
      tsMs,
      exchangeTs,
    });
  }

  ingestPriceTick(price: number, tsMs: number, exchangeTs?: number): boolean {
    if (!Number.isFinite(price) || price <= 0) {
      return false;
    }

    const ts = (exchangeTs ?? tsMs) + this.latencyOffsetMs;
    const slotMs = alignToTimeSlot(ts, this.tfMs);
    const slotTs = new Date(slotMs).toISOString();
    const existing = this.candles.get(slotMs);

    if (!existing) {
      const latest = this.getLatestCandle();
      const openPrice = latest && latest.c > 0 ? latest.c : price;
      const candle: NormalizedOhlcvBar = {
        t: slotTs,
        o: openPrice,
        h: Math.max(openPrice, price),
        l: Math.min(openPrice, price),
        c: price,
        v: 0,
        tf: this.timeframe,
        seq: slotMs,
        source: "quote-tick-new-bar",
      };
      this.candles.set(slotMs, candle);
      return true;
    }

    const nextHigh = Math.max(existing.h, price);
    const nextLow = Math.min(existing.l, price);
    if (nextHigh === existing.h && nextLow === existing.l && existing.c === price) {
      return false;
    }

    this.candles.set(slotMs, {
      ...existing,
      h: nextHigh,
      l: nextLow,
      c: price,
      source: existing.v > 0 ? "quote-tick-update" : "quote-only-update",
    });
    return true;
  }

  /**
   * Ingestion en batch (REST trades snapshot).
   */
  ingestTrades(trades: TradeForCandle[]): void {
    for (const t of trades) this.ingestTrade(t);
  }

  // ── Lecture ────────────────────────────────────────────────────────────────

  getSeries(): NormalizedOhlcvBar[] {
    return [...this.candles.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  getLatestCandle(): NormalizedOhlcvBar | null {
    const series = this.getSeries();
    return series[series.length - 1] ?? null;
  }

  // ── Double Buffer ──────────────────────────────────────────────────────────

  /**
   * Copie la série courante dans le back-buffer.
   * Appeler avant un cycle de rendu, puis swapBuffers().
   */
  prepareBackBuffer(series?: NormalizedOhlcvBar[]): void {
    this.backBuffer = series ? [...series] : this.getSeries();
  }

  /**
   * Échange front ↔ back buffer.
   * Le front-buffer devient la référence stable pour le rendu UI.
   * À appeler dans un requestAnimationFrame pour éviter le jitter.
   */
  swapBuffers(): NormalizedOhlcvBar[] {
    this.frontBuffer = this.backBuffer;
    return this.frontBuffer;
  }

  getFrontBuffer(): NormalizedOhlcvBar[] {
    return this.frontBuffer;
  }

  // ── Gap Detection ──────────────────────────────────────────────────────────

  /**
   * Détecte les trous dans une série OHLCV fournie.
   * Un trou = slot attendu absent (> 0.5× tfMs de décalage).
   * Ignore les trous en dehors de la fenêtre maxWindowMs.
   */
  detectGaps(series: NormalizedOhlcvBar[], maxWindowMs = 4 * 3600_000): GapRange[] {
    if (series.length < 2) return [];

    const gaps: GapRange[] = [];
    const cutoff = Date.now() - maxWindowMs;

    for (let i = 1; i < series.length; i++) {
      const prevMs = new Date(series[i - 1].t).getTime();
      if (prevMs < cutoff) continue;

      const currMs = new Date(series[i].t).getTime();
      const expected = prevMs + this.tfMs;

      if (currMs > expected + this.tfMs * 0.5) {
        const missingSlots = Math.round((currMs - expected) / this.tfMs);
        gaps.push({ startMs: expected, endMs: currMs, missingSlots });
      }
    }

    return gaps;
  }

  // ── Merge ──────────────────────────────────────────────────────────────────

  /**
   * Fusionne les candles reconstruites depuis trades avec une série OHLCV existante.
   *
   * Priorité :
   *   • Série OHLCV API  → plus fiable (VWAP, volume précis)
   *   • Candles trades   → comble les trous manquants
   *
   * Résultat : série dense, zéro trou pour les slots couverts par les trades.
   */
  mergeWithOhlcv(ohlcvSeries: NormalizedOhlcvBar[]): NormalizedOhlcvBar[] {
    const merged = new Map<string, NormalizedOhlcvBar>();

    // 1. Seed avec le backfill OHLCV (priorité basse)
    for (const bar of ohlcvSeries) {
      merged.set(bar.t, bar);
    }

    // 2. Les candles reconstruites depuis trades écrasent le backfill.
    for (const bar of this.getSeries()) {
      const existing = merged.get(bar.t);
      if (!existing) {
        merged.set(bar.t, bar);
        continue;
      }
      const existingLow = existing.l > 0 ? existing.l : Math.min(existing.o, existing.c);
      const barLow = bar.l > 0 ? bar.l : Math.min(bar.o, bar.c);
      merged.set(bar.t, {
        ...existing,
        o: existing.o > 0 ? existing.o : bar.o,
        h: Math.max(existing.h, bar.h, existing.o, existing.c, bar.o, bar.c),
        l: Math.min(existingLow, barLow, existing.o, existing.c, bar.o, bar.c),
        c: bar.c > 0 ? bar.c : existing.c,
        v: Math.max(existing.v, bar.v),
        tf: existing.tf || bar.tf,
        venue: existing.venue || bar.venue,
        instrument: existing.instrument || bar.instrument,
        source: bar.v > 0 ? bar.source || "trades" : existing.source || bar.source || "merged",
      });
    }

    return [...merged.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  // ── Latency Compensation ───────────────────────────────────────────────────

  /**
   * Décale les timestamps de toute la série pour compenser la latence réseau.
   * Exemple : si avgLatency = 80ms, chaque bougie est avancée de 80ms.
   * Seuil min : 50ms (en dessous = négligeable).
   */
  applyLatencyCompensation(series: NormalizedOhlcvBar[], latencyMs: number): NormalizedOhlcvBar[] {
    if (Math.abs(latencyMs) < 50) return series;
    return series.map((bar) => ({
      ...bar,
      t: new Date(new Date(bar.t).getTime() - latencyMs).toISOString(),
    }));
  }

  setLatencyOffset(latencyMs: number): void {
    this.latencyOffsetMs = Math.round(latencyMs);
  }

  // ── Utilitaires ────────────────────────────────────────────────────────────

  getTradeCount(): number {
    return this.recentTrades.length;
  }

  getCandleCount(): number {
    return this.candles.size;
  }

  reset(): void {
    this.candles.clear();
    this.recentTrades = [];
    this.backBuffer = [];
    this.frontBuffer = [];
  }
}
