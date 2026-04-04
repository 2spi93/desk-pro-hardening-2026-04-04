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

async function verifySyntheticHeartbeatOpensMicroTimeframeBar(): Promise<void> {
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
    assert.equal(previousClose, 100, "snapshot bootstrap should seed the last close used by the heartbeat");

    await waitFor(() => latestBars.length > initialBarCount, 2_500, 50);

    const heartbeatBar = latestBars[latestBars.length - 1];
    assert.ok(heartbeatBar, "synthetic heartbeat should publish a new micro-timeframe bar");
    assert.equal(heartbeatBar.o, 100, "heartbeat-opened bar should inherit the previous close as open");
    assert.ok(heartbeatBar.h >= 100, "heartbeat-opened bar should preserve or widen the high when depth wicks are applied");
    assert.ok(heartbeatBar.l <= 100, "heartbeat-opened bar should preserve or widen the low when depth wicks are applied");
    assert.equal(heartbeatBar.c, 100, "heartbeat-opened bar should keep the synthetic price as close");
    assert.equal(heartbeatBar.v, 0, "heartbeat-opened bar should remain zero-volume without trades");
  } finally {
    unsubscribe();
    bus.disconnect();
    globalThis.fetch = originalFetch;
    globalWithWindow.window = originalWindow;
  }
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

  await verifySyntheticHeartbeatOpensMicroTimeframeBar();

  console.log("PASS ohlcv-kernel regression: quote-only backfill/live fusion keeps candles mutable and heartbeat opens micro bars");
}

run().catch((error) => {
  console.error("FAIL ohlcv-kernel regression", error);
  process.exit(1);
});