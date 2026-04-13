import assert from "node:assert/strict";

import { createMarketDataBus, type OhlcvBar } from "../../lib/marketDataBus";
import { MarketDataEngineV5 } from "../../lib/marketDataEngineV5";
import { SUPPORTED_TIMEFRAMES } from "../../lib/ohlcvDataEngine";

function iso(value: string): number {
  return Date.parse(value);
}

function findBar(engine: MarketDataEngineV5, timestamp: string) {
  return engine.getSeries().find((bar) => bar.t === timestamp) || null;
}

function projectBars(bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number; tf?: string }>) {
  return bars.map((bar) => ({
    t: bar.t,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    v: bar.v,
    tf: bar.tf,
  }));
}

function assertProjectedSeriesEqual(
  actual: Array<{ t: string; o: number; h: number; l: number; c: number; v: number; tf?: string }>,
  expected: Array<{ t: string; o: number; h: number; l: number; c: number; v: number; tf?: string }>,
  message: string,
): void {
  assert.deepEqual(projectBars(actual), projectBars(expected), message);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function verifyStrictIntegrityModeSkipsSyntheticHeartbeat(): Promise<void> {
  const baseTs = Math.floor((Date.now() - 3_000) / 1_000) * 1_000;
  const baseIso = new Date(baseTs).toISOString();
  const globalWithWindow = globalThis as Record<string, unknown>;
  const originalWindow = globalWithWindow.window;
  const originalFetch = globalThis.fetch;

  const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/market/bus/snapshot")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          as_of: new Date().toISOString(),
          ohlcv_rows: [
            {
              t: baseIso,
              o: 100,
              h: 100,
              l: 100,
              c: 100,
              v: 5,
              tf: "1s",
              seq: baseTs,
            },
          ],
          depth_snapshot: {
            venue: "binance-public",
            instrument: "SOLUSDT",
            best_bid: 100,
            best_ask: 100.01,
            depth_payload: {
              bids: [[100, 1]],
              asks: [[100.01, 1]],
              event_time: baseTs,
              lastUpdateId: baseTs,
            },
          },
          trades: [],
          microstructure: null,
          routing_score: null,
          session_state: null,
          meta: { health: { status: "live" } },
        }),
      } as Response;
    }
    if (url.includes("/api/market/quotes")) {
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as Response;
    }
    if (url.includes("/api/market/ohlcv")) {
      return {
        ok: true,
        status: 200,
        json: async () => [],
      } as Response;
    }
    if (url.includes("/api/market/orderbook/depth")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          venue: "binance-public",
          instrument: "SOLUSDT",
          best_bid: 100,
          best_ask: 100.01,
          depth_payload: {
            bids: [[100, 1]],
            asks: [[100.01, 1]],
            event_time: baseTs,
            lastUpdateId: baseTs,
          },
        }),
      } as Response;
    }
    throw new Error(`Unexpected fetch in heartbeat regression: ${url}`);
  };

  const windowStub = {
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    location: {
      protocol: "https:",
      host: "app.txt.gtixt.com",
      hostname: "app.txt.gtixt.com",
    },
  };
  globalWithWindow.window = windowStub;
  globalThis.fetch = fetchStub as typeof fetch;

  const bus = createMarketDataBus();
  let latestBars: OhlcvBar[] = [];
  const unsubscribe = bus.subscribe((snapshot) => {
    latestBars = snapshot.ohlcvBars;
  });

  try {
    bus.connect({ instrument: "SOLUSDT", venue: "binance-public", timeframe: "1s" });
    await waitFor(() => latestBars.length >= 1, 2_000);

    const initialBarCount = latestBars.length;
    const previousClose = latestBars[latestBars.length - 1]?.c;
    assert.equal(previousClose, 100, "snapshot bootstrap should seed the last close used by strict integrity mode");

    await new Promise((resolve) => setTimeout(resolve, 1_250));

    assert.equal(latestBars.length, initialBarCount, "strict integrity mode must not publish synthetic heartbeat bars on micro timeframes");
    assert.equal(latestBars[latestBars.length - 1]?.t, baseIso, "strict integrity mode should keep the snapshot bar as the latest slot without synthetic heartbeat");
  } finally {
    unsubscribe();
    bus.disconnect();
    globalThis.fetch = originalFetch;
    globalWithWindow.window = originalWindow;
  }
}

function verifyReplayAndLiveProduceIdenticalSeries(): void {
  const baseBarTime = "2026-03-30T11:59:00.000Z";
  const baseBar = {
    t: baseBarTime,
    o: 100,
    h: 100,
    l: 99.5,
    c: 100,
    v: 10,
    tf: "1m",
    seq: iso(baseBarTime),
  };

  const trades = [
    { price: 101, size: 2, side: "buy", tsMs: iso("2026-03-30T12:00:05.000Z") },
    { price: 104, size: 1, side: "buy", tsMs: iso("2026-03-30T12:00:25.000Z") },
    { price: 102, size: 3, side: "sell", tsMs: iso("2026-03-30T12:00:50.000Z") },
    { price: 103, size: 2, side: "buy", tsMs: iso("2026-03-30T12:01:10.000Z") },
    { price: 99, size: 1, side: "sell", tsMs: iso("2026-03-30T12:01:40.000Z") },
    { price: 106, size: 4, side: "buy", tsMs: iso("2026-03-30T12:04:55.000Z") },
  ];
  const quoteTicks = [
    { price: 105.5, tsMs: iso("2026-03-30T12:00:55.000Z") },
    { price: 98.5, tsMs: iso("2026-03-30T12:01:45.000Z") },
    { price: 107.25, tsMs: iso("2026-03-30T12:04:58.000Z") },
  ];
  const domBids: Array<[number, number]> = [[107.0, 5], [106.5, 3]];
  const domAsks: Array<[number, number]> = [[107.5, 4], [108.0, 6]];

  const replayEngine = new MarketDataEngineV5("1m", "SOLUSDT", "binance");
  const liveEngine = new MarketDataEngineV5("1m", "SOLUSDT", "binance");

  replayEngine.bootstrap({ ohlcvBars: [baseBar], trades });
  liveEngine.bootstrap({ ohlcvBars: [baseBar] });
  for (const trade of trades) {
    liveEngine.ingestTrade(trade);
  }

  for (const tick of quoteTicks) {
    replayEngine.ingestTick(tick.price, tick.tsMs, "binance");
    liveEngine.ingestTick(tick.price, tick.tsMs, "binance");
  }

  replayEngine.ingestDepthSnapshot([...domBids], [...domAsks]);
  liveEngine.ingestDepthSnapshot([...domBids], [...domAsks]);

  assertProjectedSeriesEqual(
    liveEngine.getSeries(),
    replayEngine.getSeries(),
    "replay and live pipelines must yield the exact same 1m merged series",
  );
  assertProjectedSeriesEqual(
    liveEngine.getSeries("5m"),
    replayEngine.getSeries("5m"),
    "replay and live pipelines must yield the exact same 5m derived series",
  );

  const replayFrame = replayEngine.getSyncedFrame([...domBids], [...domAsks]);
  const liveFrame = liveEngine.getSyncedFrame([...domBids], [...domAsks]);
  assert.equal(liveFrame.slotIso, replayFrame.slotIso, "replay and live synced frames must anchor the same candle slot");
  assert.equal(liveFrame.domDelta, replayFrame.domDelta, "replay and live synced frames must expose the same DOM delta");
  assert.deepEqual(liveFrame.audit, replayFrame.audit, "replay and live synced frames must expose the same audit snapshot");
}

function verifyReconstructedFiveMinuteMatchesLiveFiveMinute(): void {
  const trades = [
    { price: 101, size: 2, side: "buy", tsMs: iso("2026-03-30T12:00:05.000Z") },
    { price: 104, size: 1, side: "buy", tsMs: iso("2026-03-30T12:00:25.000Z") },
    { price: 102, size: 3, side: "sell", tsMs: iso("2026-03-30T12:00:50.000Z") },
    { price: 103, size: 2, side: "buy", tsMs: iso("2026-03-30T12:01:10.000Z") },
    { price: 99, size: 1, side: "sell", tsMs: iso("2026-03-30T12:01:40.000Z") },
    { price: 106, size: 4, side: "buy", tsMs: iso("2026-03-30T12:04:55.000Z") },
  ];
  const quoteTicks = [
    { price: 105.5, tsMs: iso("2026-03-30T12:00:55.000Z") },
    { price: 98.5, tsMs: iso("2026-03-30T12:01:45.000Z") },
    { price: 107.25, tsMs: iso("2026-03-30T12:04:58.000Z") },
  ];

  const tickEngine = new MarketDataEngineV5("1m", "SOLUSDT", "binance");
  tickEngine.bootstrap({ ohlcvBars: [], trades });
  for (const tick of quoteTicks) {
    tickEngine.ingestTick(tick.price, tick.tsMs, "binance");
  }

  const reconstructedFiveMinute = tickEngine.getSeries("5m");
  const expectedLiveFiveMinute = {
    t: "2026-03-30T12:00:00.000Z",
    o: 101,
    h: 107.25,
    l: 98.5,
    c: 107.25,
    v: 13,
    tf: "5m",
    seq: 1,
  };

  assert.equal(reconstructedFiveMinute.length, 1, "the reconstructed 5m series should collapse into a single bar for the 5-minute window");
  assertProjectedSeriesEqual(
    reconstructedFiveMinute,
    [expectedLiveFiveMinute],
    "the reconstructed 5m candle must match the canonical candle built from the tick stream",
  );

  const liveFiveMinuteEngine = new MarketDataEngineV5("5m", "SOLUSDT", "binance");
  liveFiveMinuteEngine.bootstrap({ ohlcvBars: [] });
  liveFiveMinuteEngine.ingestWsBar(expectedLiveFiveMinute);

  assertProjectedSeriesEqual(
    reconstructedFiveMinute,
    liveFiveMinuteEngine.getSeries("5m"),
    "the 5m candle reconstructed from ticks must stay identical to the 5m live candle",
  );
}

function verifyMicroQuotesDoNotRewriteTradeBodies(): void {
  const engine = new MarketDataEngineV5("1s", "SOLUSDT", "binance");
  engine.bootstrap({ ohlcvBars: [] });

  engine.ingestTrade({ price: 100, size: 1.2, side: "buy", tsMs: iso("2026-03-30T11:00:00.120Z") });
  assert.equal(
    engine.ingestTick(100.8, iso("2026-03-30T11:00:00.420Z"), "binance"),
    false,
    "micro quote should not mutate a trade-built candle",
  );

  const currentBar = findBar(engine, "2026-03-30T11:00:00.000Z");
  assert.ok(currentBar, "expected micro candle after first trade");
  assert.equal(currentBar?.o, 100, "micro trade-built candle should keep the first trade as open");
  assert.equal(currentBar?.h, 100, "micro trade-built candle should not inherit quote highs");
  assert.equal(currentBar?.l, 100, "micro trade-built candle should not inherit quote lows");
  assert.equal(currentBar?.c, 100, "micro trade-built candle close should remain trade-only");
  assert.equal(currentBar?.v, 1.2, "micro trade-built candle should keep trade volume only");
}

function verifyFirstTradeResetsQuoteSeedOnMicroTimeframe(): void {
  const seedBarTime = "2026-03-30T11:00:00.000Z";
  const engine = new MarketDataEngineV5("1s", "SOLUSDT", "binance");

  engine.bootstrap({
    ohlcvBars: [
      {
        t: seedBarTime,
        o: 100,
        h: 100,
        l: 100,
        c: 100,
        v: 4,
        tf: "1s",
        seq: iso(seedBarTime),
      },
    ],
  });

  assert.equal(
    engine.ingestTick(100, iso("2026-03-30T11:00:01.040Z"), "binance"),
    true,
    "cross-slot micro quote should still open a placeholder bar",
  );
  engine.ingestTrade({ price: 101.25, size: 2, side: "buy", tsMs: iso("2026-03-30T11:00:01.180Z") });
  assert.equal(
    engine.ingestTick(99.5, iso("2026-03-30T11:00:01.600Z"), "binance"),
    false,
    "subsequent micro quotes should not rewrite the trade-confirmed body",
  );

  const nextBar = findBar(engine, "2026-03-30T11:00:01.000Z");
  assert.ok(nextBar, "expected placeholder slot to become a trade-confirmed candle");
  assert.equal(nextBar?.o, 101.25, "first trade must replace the quote-seeded open on micro timeframe");
  assert.equal(nextBar?.h, 101.25, "first trade must replace quote-seeded highs on micro timeframe");
  assert.equal(nextBar?.l, 101.25, "first trade must replace quote-seeded lows on micro timeframe");
  assert.equal(nextBar?.c, 101.25, "micro candle close should stay trade-only after the first trade");
  assert.equal(nextBar?.v, 2, "micro candle should accumulate the first trade volume");
}

function verifyMicroTradesOverrideBackfillBody(): void {
  const slotTime = "2026-03-30T11:00:00.000Z";
  const engine = new MarketDataEngineV5("1s", "SOLUSDT", "binance");

  engine.bootstrap({
    ohlcvBars: [
      {
        t: slotTime,
        o: 100,
        h: 105,
        l: 95,
        c: 104,
        v: 12,
        tf: "1s",
        seq: iso(slotTime),
      },
    ],
  });

  engine.ingestTrade({ price: 101, size: 1.5, side: "buy", tsMs: iso("2026-03-30T11:00:00.250Z") });

  const bar = findBar(engine, slotTime);
  assert.ok(bar, "expected micro bar after trade reconstruction over backfill");
  assert.equal(bar?.o, 101, "micro reconstructed open must come from the first trade, not stale backfill");
  assert.equal(bar?.h, 101, "micro reconstructed high must stay trade-only");
  assert.equal(bar?.l, 101, "micro reconstructed low must stay trade-only");
  assert.equal(bar?.c, 101, "micro reconstructed close must stay trade-only");
  assert.equal(bar?.v, 12, "merged volume may keep the richer backfill volume for telemetry");
}

async function run(): Promise<void> {
  const engine = new MarketDataEngineV5("1m", "SOLUSDT", "binance");
  const baseBarTime = "2026-03-30T11:00:00.000Z";

  engine.bootstrap({
    ohlcvBars: [
      {
        t: baseBarTime,
        o: 84,
        h: 84,
        l: 84,
        c: 84,
        v: 12,
        tf: "1m",
        seq: iso(baseBarTime),
      },
    ],
  });

  assert.equal(engine.ingestTick(84.49, iso("2026-03-30T11:00:20.000Z"), "binance"), true, "quote tick should update current candle high");
  assert.equal(engine.ingestTick(84.12, iso("2026-03-30T11:00:40.000Z"), "binance"), true, "quote tick should update current candle close");

  const currentBar = findBar(engine, baseBarTime);
  assert.ok(currentBar, "expected merged current candle after quote-only updates");
  assert.equal(currentBar?.o, 84, "backfill open should be preserved");
  assert.equal(currentBar?.h, 84.49, "quote-only update should raise high");
  assert.equal(currentBar?.l, 84, "quote-only update should preserve low when price stays above low");
  assert.equal(currentBar?.c, 84.12, "quote-only update should set close");
  assert.equal(currentBar?.v, 12, "quote-only update should preserve backfill volume");

  assert.equal(engine.ingestTick(84.55, iso("2026-03-30T11:00:58.000Z"), "binance"), true, "late quote should still update the current slot");
  assert.equal(engine.ingestTick(84.08, iso("2026-03-30T11:01:03.000Z"), "binance"), true, "cross-slot quote should open a new zero-volume candle");

  const nextBarTime = "2026-03-30T11:01:00.000Z";
  const nextBar = findBar(engine, nextBarTime);
  assert.ok(nextBar, "expected next slot candle after cross-slot quote update");
  assert.equal(nextBar?.o, 84.55, "new quote-only bar should open from prior close");
  assert.equal(nextBar?.h, 84.55, "new quote-only bar high should include inherited open");
  assert.equal(nextBar?.l, 84.08, "new quote-only bar low should follow quote move");
  assert.equal(nextBar?.c, 84.08, "new quote-only bar close should match latest quote");
  assert.equal(nextBar?.v, 0, "quote-only bar should remain zero-volume until a trade arrives");

  const preparedSeries = engine.getSeries();
  engine.prepareFrame(preparedSeries);
  const swapped = engine.swapFrame();
  assert.equal(swapped.length, preparedSeries.length, "prepared frame should publish the merged series without dropping bars");
  assert.deepEqual(swapped[swapped.length - 1], preparedSeries[preparedSeries.length - 1], "double buffer should preserve the latest merged bar");

  const timeframes = engine.getSupportedTimeframes();
  assert.ok(timeframes.includes("1s"), "multi-timeframe engine should expose micro timeframes");
  assert.ok(timeframes.includes("4h"), "multi-timeframe engine should expose higher intraday timeframes");
  assert.ok(timeframes.includes("1d"), "multi-timeframe engine should expose daily timeframes");
  assert.ok(timeframes.includes("1M"), "multi-timeframe engine should expose monthly timeframe");
  assert.ok(SUPPORTED_TIMEFRAMES.every((timeframe) => timeframes.includes(timeframe)), "engine should preload the supported timeframe registry");

  const fiveMinuteSeries = engine.getSeries("5m");
  assert.equal(fiveMinuteSeries.length, 1, "1m backfill/live data should aggregate into a single 5m candle");
  assert.equal(fiveMinuteSeries[0]?.o, 84, "aggregated 5m candle should preserve first open");
  assert.equal(fiveMinuteSeries[0]?.h, 84.55, "aggregated 5m candle should preserve session high");
  assert.equal(fiveMinuteSeries[0]?.l, 84, "aggregated 5m candle should preserve session low");
  assert.equal(fiveMinuteSeries[0]?.c, 84.08, "aggregated 5m candle should preserve latest close");
  assert.equal(fiveMinuteSeries[0]?.v, 12, "aggregated 5m candle should preserve accumulated backfill volume");

  engine.prepareFrame(fiveMinuteSeries, "5m");
  const swappedFiveMinute = engine.swapFrame("5m");
  assert.equal(swappedFiveMinute.length, fiveMinuteSeries.length, "timeframe-scoped back buffer should swap independently");
  assert.equal(swappedFiveMinute[0]?.tf, "5m", "timeframe-scoped frame should carry the selected timeframe");

  verifyReplayAndLiveProduceIdenticalSeries();
  verifyReconstructedFiveMinuteMatchesLiveFiveMinute();
  verifyMicroQuotesDoNotRewriteTradeBodies();
  verifyFirstTradeResetsQuoteSeedOnMicroTimeframe();
  verifyMicroTradesOverrideBackfillBody();

  await verifyStrictIntegrityModeSkipsSyntheticHeartbeat();

  console.log("PASS ohlcv-kernel regression: quote-only fusion, replay/live parity, strict micro integrity, and 5m tick-vs-live parity all hold");
}

run().catch((error) => {
  console.error("FAIL ohlcv-kernel regression", error);
  process.exit(1);
});