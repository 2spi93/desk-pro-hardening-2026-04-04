/**
 * MarketDataEngine V5 — Pipeline Unifié (Hedge Fund Grade)
 *
 * Architecture :
 *   EXCHANGE (trades + depth + quotes)
 *         ↓
 *   CandleEngineV5  (reconstruction tick-level depuis trades)
 *   MarketDataEngineV3 (backfill OHLCV uniquement)
 *         ↓
 *   MERGE  (V3 prioritaire + V5 comble les gaps)
 *         ↓
 *   MarketDataEngineV4 (microstructure : CVD, imbalance, latency, events)
 *         ↓
 *   Latency Compensation → série finale corrigée
 *
 * Points clés vs TV / Quantower :
 *   ✅ Candles construites depuis trades (tick-level)
 *   ✅ Zéro trou (gaps comblés depuis buffer trades)
 *   ✅ Latency offset adjustement (ts exchange → ts réseau compensé)
 *   ✅ Multi-feed VWAP via V4
 *   ✅ Pre-build avant premier render (stable=true avant emit)
 *   ✅ Double buffer via CandleV5 (swapBuffers → zéro jitter)
 */

import { MarketDataEngineV3 } from "./marketDataEngineV3";
import {
  MarketDataEngineV4,
  type MicrostructureSnapshot,
  type DepthRow,
  type VenueTick,
  type TradeInput,
} from "./marketDataEngineV4";
import { CandleEngineV5, type TradeForCandle, type GapRange, type CandleAuditResult } from "./candleEngineV5";
import type { NormalizedOhlcvBar } from "./ohlcvIntegrity";
import { aggregateBarsToTimeframe, canDeriveTimeframe, normalizeTimeframe, SUPPORTED_TIMEFRAMES, timeframeToMs } from "./ohlcvDataEngine";
import { buildSyncedFrame, type SyncedMarketFrame } from "./syncedMarketFrame";

// ── Types ──────────────────────────────────────────────────────────────────────

export type { GapRange, CandleAuditResult, SyncedMarketFrame };

export type BootstrapInput = {
  ohlcvBars: NormalizedOhlcvBar[];
  trades?: TradeInput[];
  latencyMs?: number;
};

export type V5SeriesSnapshot = {
  bars: NormalizedOhlcvBar[];
  isStable: boolean;
  gapsDetected: GapRange[];
  tradeCandleCount: number;
  source: "ohlcv" | "trades" | "merged";
};

export type V5FlowScore = {
  score: number;        // [0, 1] — force du signal directionnel
  direction: "buy" | "sell" | "neutral";
  components: {
    depthImbalance: number;
    cvdDelta: number;
    aggressiveness: number;
  };
};

type TimeframeRuntime = {
  v3: MarketDataEngineV3;
  candleEngine: CandleEngineV5;
  lastGaps: GapRange[];
};

// ── Engine ─────────────────────────────────────────────────────────────────────

export class MarketDataEngineV5 {
  private v4: MarketDataEngineV4;
  private runtimes: Map<string, TimeframeRuntime>;

  private timeframe: string;
  private instrument: string;
  private venue: string;
  private supportedTimeframes: string[];

  private latencyOffsetMs = 0;
  private stable = false;
  private lastGaps: GapRange[] = [];
  private backfillCallback: ((startMs: number, endMs: number) => void) | null = null;

  constructor(timeframe: string, instrument: string, venue: string) {
    this.timeframe = normalizeTimeframe(timeframe);
    this.instrument = instrument;
    this.venue = venue;
    this.v4 = new MarketDataEngineV4();
    this.supportedTimeframes = [...new Set([...SUPPORTED_TIMEFRAMES, this.timeframe])];
    this.runtimes = this.createRuntimes();
  }

  private createRuntime(timeframe: string): TimeframeRuntime {
    const normalized = normalizeTimeframe(timeframe);
    return {
      v3: new MarketDataEngineV3(normalized, this.instrument, this.venue),
      candleEngine: new CandleEngineV5(normalized),
      lastGaps: [],
    };
  }

  private createRuntimes(): Map<string, TimeframeRuntime> {
    const runtimes = new Map<string, TimeframeRuntime>();
    for (const timeframe of this.supportedTimeframes) {
      runtimes.set(timeframe, this.createRuntime(timeframe));
    }
    return runtimes;
  }

  private ensureRuntime(timeframe: string): TimeframeRuntime {
    const normalized = normalizeTimeframe(timeframe);
    const existing = this.runtimes.get(normalized);
    if (existing) {
      return existing;
    }
    const runtime = this.createRuntime(normalized);
    if (this.latencyOffsetMs !== 0) {
      runtime.candleEngine.setLatencyOffset(this.latencyOffsetMs);
    }
    this.runtimes.set(normalized, runtime);
    if (!this.supportedTimeframes.includes(normalized)) {
      this.supportedTimeframes.push(normalized);
    }
    return runtime;
  }

  private updateActiveGaps(timeframe = this.timeframe): void {
    const runtime = this.ensureRuntime(timeframe);
    const tradeSeries = runtime.candleEngine.getSeries();
    const referenceSeries = tradeSeries.length > 0 ? tradeSeries : runtime.v3.getSeries();
    runtime.lastGaps = runtime.candleEngine.detectGaps(referenceSeries);
    if (timeframe === this.timeframe) {
      this.lastGaps = runtime.lastGaps;
    }
  }

  private isMicroTradeOnlyTimeframe(timeframe: string): boolean {
    return timeframeToMs(normalizeTimeframe(timeframe)) <= 5_000;
  }

  private mergedSeriesFor(timeframe: string): NormalizedOhlcvBar[] {
    const normalized = normalizeTimeframe(timeframe);
    const runtime = this.ensureRuntime(normalized);
    const tradeSeries = runtime.candleEngine.getSeries();
    const v3Series = runtime.v3.getSeries();

    if (tradeSeries.length === 0) {
      this.updateActiveGaps(normalized);
      return v3Series;
    }

    this.updateActiveGaps(normalized);
    if (normalized === this.timeframe && runtime.lastGaps.length > 0 && this.backfillCallback) {
      for (const gap of runtime.lastGaps) {
        this.backfillCallback(gap.startMs, gap.endMs);
      }
    }

    const merged = runtime.candleEngine.mergeWithOhlcv(v3Series);
    return this.latencyOffsetMs > 50
      ? runtime.candleEngine.applyLatencyCompensation(merged, this.latencyOffsetMs)
      : merged;
  }

  setActiveTimeframe(timeframe: string): void {
    this.timeframe = normalizeTimeframe(timeframe);
    this.ensureRuntime(this.timeframe);
    this.updateActiveGaps(this.timeframe);
  }

  getActiveTimeframe(): string {
    return this.timeframe;
  }

  getSupportedTimeframes(): string[] {
    return [...this.supportedTimeframes];
  }

  // ── Bootstrap (PREBUILD AVANT RENDER) ────────────────────────────────────────

  /**
   * Bootstrap complet : ingère la série OHLCV REST + le batch trades REST,
   * reconstruit les candles depuis trades, détecte les gaps.
   *
   * ⚠️ Doit être appelé AVANT le premier emit() du bus.
   *    stable = true seulement après cette méthode.
   */
  bootstrap(input: BootstrapInput): void {
    this.reset();
    this.stable = false;

    const activeTf = this.timeframe;

    // 1. V3 : backfill OHLCV uniquement (historique / secours)
    if (input.ohlcvBars.length > 0) {
      const activeRuntime = this.ensureRuntime(activeTf);
      activeRuntime.v3.ingestSnapshot(input.ohlcvBars);
      for (const timeframe of this.supportedTimeframes) {
        if (timeframe === activeTf || !canDeriveTimeframe(activeTf, timeframe)) {
          continue;
        }
        const runtime = this.ensureRuntime(timeframe);
        runtime.v3.ingestSnapshot(aggregateBarsToTimeframe(input.ohlcvBars, timeframe));
      }
    }

    // 2. CandleV5 : reconstruction depuis batch trades
    if (input.trades && input.trades.length > 0) {
      const tradesToIngest: TradeForCandle[] = input.trades.map((t) => ({
        price: t.price,
        size: t.size,
        side: String(t.side ?? ""),
        tsMs: (t as TradeInput & { tsMs?: number }).tsMs ?? Date.now(),
        exchangeTs: (t as TradeInput & { exchangeTs?: number }).exchangeTs,
      }));
      for (const runtime of this.runtimes.values()) {
        runtime.candleEngine.ingestTrades(tradesToIngest);
      }

      // Nourrir V4 microstructure
      for (const t of input.trades) {
        this.v4.ingestTrade(t);
      }
    }

    // 3. Latency offset initial
    if (input.latencyMs !== undefined) {
      this.latencyOffsetMs = input.latencyMs;
      for (const runtime of this.runtimes.values()) {
        runtime.candleEngine.setLatencyOffset(this.latencyOffsetMs);
      }
    }

    // 4. Détection immédiate des gaps
    this.updateActiveGaps();

    // 5. Déclencher backfill si gaps détectés
    if (this.lastGaps.length > 0 && this.backfillCallback) {
      for (const gap of this.lastGaps) {
        this.backfillCallback(gap.startMs, gap.endMs);
      }
    }

    this.stable = true;
  }

  // ── Ingestion temps réel ──────────────────────────────────────────────────────

  ingestWsBar(bar: NormalizedOhlcvBar): void {
    const activeRuntime = this.ensureRuntime(this.timeframe);
    activeRuntime.v3.ingestWsBar(bar);
    for (const timeframe of this.supportedTimeframes) {
      if (timeframe === this.timeframe || !canDeriveTimeframe(this.timeframe, timeframe)) {
        continue;
      }
      const runtime = this.ensureRuntime(timeframe);
      // Use tick-reconstructed merged series as HTF source (not raw V3-only backfill).
      // Critical: ensures 1m candle micro-structure is preserved when building 5m/15m/etc.
      const aggregated = aggregateBarsToTimeframe(this.mergedSeriesFor(this.timeframe), timeframe);
      runtime.v3.reset();
      runtime.v3.ingestSnapshot(aggregated);
    }
  }

  ingestTrade(trade: TradeInput & { tsMs?: number; exchangeTs?: number }): void {
    const ts = trade.exchangeTs ?? trade.tsMs ?? Date.now();

    // Candle reconstruction depuis trade
    for (const runtime of this.runtimes.values()) {
      runtime.candleEngine.ingestTrade({
        price: trade.price,
        size: trade.size,
        side: String(trade.side ?? ""),
        tsMs: ts,
        exchangeTs: trade.exchangeTs,
      });
    }

    // Microstructure V4
    this.v4.ingestTrade(trade);
  }

  ingestTradeFast(price: number, size: number, sideFlag: number, tsMs: number, venue?: string): void {
    for (const runtime of this.runtimes.values()) {
      runtime.candleEngine.ingestTradeFast(price, size, sideFlag, tsMs);
    }
    this.v4.ingestTradeFast(price, size, sideFlag, tsMs);
    this.v4.ingestTickFast(venue ?? this.venue, price, tsMs, size);
  }

  ingestTrades(trades: Array<TradeInput & { tsMs?: number; exchangeTs?: number }>): void {
    for (const t of trades) this.ingestTrade(t);
  }

  /**
   * Injection tick prix live.
   * Retourne true si la bougie courante a changé (→ bus doit émettre).
   */
  ingestTick(price: number, tsMs: number, venue?: string): boolean {
    const v4tick: VenueTick = { venue: venue ?? this.venue ?? "primary", price, tsMs };
    this.v4.ingestTick(v4tick);
    let activeChanged = false;
    for (const [timeframe, runtime] of this.runtimes.entries()) {
      const v3Changed = this.isMicroTradeOnlyTimeframe(timeframe)
        ? false
        : runtime.v3.ingestTick(price, tsMs);
      const tradeChanged = runtime.candleEngine.ingestPriceTick(price, tsMs);
      if (timeframe === this.timeframe) {
        activeChanged = v3Changed || tradeChanged;
      }
    }
    return activeChanged;
  }

  ingestDepth(delta: { bids?: DepthRow[]; asks?: DepthRow[] }): void {
    this.v4.ingestDepth(delta);
  }

  ingestDepthSnapshot(bids: DepthRow[], asks: DepthRow[]): void {
    this.v4.ingestDepthSnapshot(bids, asks);
  }

  // ── Série finale (merge - priorité OHLCV - gaps comblés par trades) ──────────

  getSeries(timeframe = this.timeframe): NormalizedOhlcvBar[] {
    return this.mergedSeriesFor(timeframe);
  }

  getSeriesSnapshot(timeframe = this.timeframe): V5SeriesSnapshot {
    const runtime = this.ensureRuntime(timeframe);
    const v3Series = runtime.v3.getSeries();
    const tradeSeries = runtime.candleEngine.getSeries();
    const gaps = runtime.candleEngine.detectGaps(v3Series);

    const bars = this.getSeries(timeframe);

    const source: V5SeriesSnapshot["source"] =
      tradeSeries.length > 0 && gaps.length > 0 ? "merged"
      : tradeSeries.length > 0 ? "trades"
      : "ohlcv";

    return { bars, isStable: this.stable, gapsDetected: gaps, tradeCandleCount: tradeSeries.length, source };
  }

  getCurrentBar(timeframe = this.timeframe): NormalizedOhlcvBar | null {
    const runtime = this.ensureRuntime(timeframe);
    return runtime.candleEngine.getLatestCandle() ?? runtime.v3.getCurrentBar();
  }

  // ── Double Buffer (pour render zéro jitter) ───────────────────────────────────

  /**
   * Prépare le back-buffer avec la série courante.
   * Appeler avant requestAnimationFrame.
   */
  prepareFrame(series?: NormalizedOhlcvBar[], timeframe = this.timeframe): void {
    const runtime = this.ensureRuntime(timeframe);
    runtime.candleEngine.prepareBackBuffer(series ?? this.getSeries(timeframe));
  }

  /**
   * Swaps front ↔ back buffer.
   * Appeler DANS requestAnimationFrame pour un render atomique.
   */
  swapFrame(timeframe = this.timeframe): NormalizedOhlcvBar[] {
    const runtime = this.ensureRuntime(timeframe);
    return runtime.candleEngine.swapBuffers();
  }

  // ── Microstructure V4 ─────────────────────────────────────────────────────────

  getMicrostructure(): MicrostructureSnapshot {
    return this.v4.getSnapshot();
  }

  /**
   * Flow Score unifié — combine depth imbalance, CVD delta, et aggressivité.
   * Utilisé par la couche signal pour qualifier la direction du marché.
   */
  getFlowScore(): V5FlowScore {
    const micro = this.v4.getSnapshot();

    const depthImbalance = micro.depthImbalance;           // [-1, +1]
    const cvdDelta = Math.tanh(micro.cvdDelta * 0.001);    // normalise via tanh
    const aggressiveness = micro.tradeAggressiveness * 2 - 1; // [0,1] → [-1,+1]

    const score =
      depthImbalance * 0.4 +
      cvdDelta       * 0.3 +
      aggressiveness * 0.3;

    const absScore = Math.abs(score);
    const direction: V5FlowScore["direction"] =
      absScore < 0.08 ? "neutral"
      : score > 0 ? "buy"
      : "sell";

    return {
      score: Math.min(1, absScore),
      direction,
      components: { depthImbalance, cvdDelta, aggressiveness },
    };
  }

  // ── Latency ───────────────────────────────────────────────────────────────────

  updateLatencyOffset(latencyMs: number): void {
    this.latencyOffsetMs = latencyMs;
    for (const runtime of this.runtimes.values()) {
      runtime.candleEngine.setLatencyOffset(latencyMs);
    }
  }

  getLatencyOffset(): number {
    return this.latencyOffsetMs;
  }

  /**
   * Met à jour le latency offset automatiquement depuis les mesures V4.
   */
  syncLatencyFromV4(): void {
    const micro = this.v4.getSnapshot();
    if (micro.avgLatencyMs > 0) {
      this.updateLatencyOffset(Math.round(micro.avgLatencyMs));
    }
  }

  // ── Gaps / Backfill ───────────────────────────────────────────────────────────

  getGaps(): GapRange[] {
    return this.lastGaps;
  }

  /**
   * Enregistre un callback appelé quand des gaps sont détectés.
   * Le bus utilise ce callback pour déclencher un fetch backfill.
   */
  onGapDetected(cb: (startMs: number, endMs: number) => void): void {
    this.backfillCallback = cb;
  }

  isStable(): boolean {
    return this.stable;
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────────

  getStats(): {
    v3: ReturnType<MarketDataEngineV3["getStats"]>;
    tradeCandleCount: number;
    gapCount: number;
    latencyOffsetMs: number;
    stable: boolean;
    flowScore: V5FlowScore;
    timeframeCount: number;
    activeTimeframe: string;
  } {
    const activeRuntime = this.ensureRuntime(this.timeframe);
    return {
      v3: activeRuntime.v3.getStats(),
      tradeCandleCount: activeRuntime.candleEngine.getCandleCount(),
      gapCount: this.lastGaps.length,
      latencyOffsetMs: this.latencyOffsetMs,
      stable: this.stable,
      flowScore: this.getFlowScore(),
      timeframeCount: this.runtimes.size,
      activeTimeframe: this.timeframe,
    };
  }

  // ── Synced Frame ──────────────────────────────────────────────────────────────

  /**
   * Returns an atomic frame tying the current candle, DOM depth and footprint delta
   * to the same UTC-aligned timestamp.  Callers may supply raw depth rows from an
   * external orderbook snapshot; if omitted the V4 microstructure best-level is used.
   */
  getSyncedFrame(bidsRaw?: DepthRow[], asksRaw?: DepthRow[]): SyncedMarketFrame {
    const candle = this.getCurrentBar();
    const micro = this.v4.getSnapshot();
    const runtime = this.ensureRuntime(this.timeframe);
    const series = this.getSeries();
    const auditResult: CandleAuditResult = runtime.candleEngine.audit(series);

    const effectiveBids: DepthRow[] = bidsRaw ?? (micro.bestBid > 0 ? [[micro.bestBid, micro.bidVolume]] : []);
    const effectiveAsks: DepthRow[] = asksRaw ?? (micro.bestAsk > 0 ? [[micro.bestAsk, micro.askVolume]] : []);

    return buildSyncedFrame(
      candle,
      effectiveBids,
      effectiveAsks,
      micro.cvdDelta,
      runtime.candleEngine.getCandleCount() > 0,
      {
        wickConsistency: auditResult.wickConsistency,
        tfAlignmentScore: auditResult.tfAlignmentScore,
        gapCount: auditResult.gapCount,
      },
    );
  }

  // ── Reset ──────────────────────────────────────────────────────────────────────

  reset(): void {
    this.runtimes = this.createRuntimes();
    this.v4.reset();
    this.stable = false;
    this.lastGaps = [];
    this.latencyOffsetMs = 0;
    for (const runtime of this.runtimes.values()) {
      runtime.candleEngine.setLatencyOffset(0);
    }
  }
}
