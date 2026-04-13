/**
 * SyncedMarketFrame — Atomic snapshot tying candle, DOM depth and footprint delta
 * to a single UTC-aligned timestamp.
 *
 * Design goal : the AI orchestrator and any risk consumer should read a single
 * coherent frame rather than racing separate candle / orderbook / trade states.
 */

import type { NormalizedOhlcvBar } from "./ohlcvIntegrity";
import type { DepthRow } from "./marketDataEngineV4";
import type { CandleAuditResult } from "./candleEngineV5";

// ── Types ──────────────────────────────────────────────────────────────────────

export type DomLevel = {
  price: number;
  size: number;
  side: "bid" | "ask";
};

/**
 * A fully synchronised market frame.
 *
 * All fields share the same `ts` epoch-ms anchor. Consumers MUST reject frames
 * where `ts` diverges from their local clock by more than `staleness` ms.
 */
export type SyncedMarketFrame = {
  /** UTC epoch ms — aligned to the current candle's slot boundary. */
  ts: number;
  /** ISO timestamp of the slot (bar.t of the last candle). */
  slotIso: string;
  /** The most recently completed (or live) candle for the active timeframe. */
  candle: NormalizedOhlcvBar | null;
  /** Best-bid side DOM levels (sorted desc by price). */
  bids: DomLevel[];
  /** Best-ask side DOM levels (sorted asc by price). */
  asks: DomLevel[];
  /** Net DOM delta: totalBidSize - totalAskSize across the captured depth levels. */
  domDelta: number;
  /** Net footprint delta: buyVolume - sellVolume for this candle's slot (from trades). */
  footprintDelta: number;
  /** True when the candle was built from raw trades (not OHLCV-only backfill). */
  isTickTrue: boolean;
  /** Source tag for the candle data. */
  source: "tick" | "ohlcv" | "merged";
  /** Audit snapshot at frame creation time (may be null if audit was not requested). */
  audit: Pick<CandleAuditResult, "wickConsistency" | "tfAlignmentScore" | "gapCount"> | null;
};

// ── Builder ────────────────────────────────────────────────────────────────────

function depthRowsToDomLevels(rows: DepthRow[], side: "bid" | "ask"): DomLevel[] {
  return rows.map(([price, size]) => ({ price, size, side }));
}

/**
 * Constructs a `SyncedMarketFrame` from live engine outputs.
 *
 * @param candle       Latest candle (merged series head).
 * @param bidsRaw      Raw bid depth rows `[price, size][]` — sorted desc.
 * @param asksRaw      Raw ask depth rows `[price, size][]` — sorted asc.
 * @param footprintDelta Net trade delta (buy vol − sell vol) for this candle slot.
 * @param isTickTrue   Whether the candle was reconstructed from trades.
 * @param auditSlice   Optional lightweight audit metrics (no issues array needed here).
 */
export function buildSyncedFrame(
  candle: NormalizedOhlcvBar | null,
  bidsRaw: DepthRow[],
  asksRaw: DepthRow[],
  footprintDelta: number,
  isTickTrue: boolean,
  auditSlice?: Pick<CandleAuditResult, "wickConsistency" | "tfAlignmentScore" | "gapCount"> | null,
): SyncedMarketFrame {
  const tsMs = candle ? new Date(candle.t).getTime() : Date.now();
  const slotIso = candle?.t ?? new Date(tsMs).toISOString();

  const bids = depthRowsToDomLevels(bidsRaw, "bid");
  const asks = depthRowsToDomLevels(asksRaw, "ask");

  const totalBidSize = bids.reduce((acc, l) => acc + l.size, 0);
  const totalAskSize = asks.reduce((acc, l) => acc + l.size, 0);
  const domDelta = totalBidSize - totalAskSize;

  const candleSource = candle?.source;
  const source: SyncedMarketFrame["source"] =
    candleSource === "trades" || candleSource === "tick-bar" ? "tick"
    : candleSource === "merged" ? "merged"
    : "ohlcv";

  return {
    ts: tsMs,
    slotIso,
    candle,
    bids,
    asks,
    domDelta,
    footprintDelta,
    isTickTrue,
    source,
    audit: auditSlice ?? null,
  };
}
