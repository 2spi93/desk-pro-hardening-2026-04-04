const assert = require("node:assert/strict");

const {
  MARKET_SNAPSHOT_CONTRACT_VERSION,
  assessMarketSnapshot,
  shouldUseCanonicalSnapshot,
} = require(process.env.MARKET_SNAPSHOT_CONTRACT_MODULE);

const NOW = Date.parse("2026-07-22T12:00:00Z");

function rows(count, symbol = "BTCUSDT", last = NOW - 30_000) {
  return Array.from({ length: count }, (_, index) => ({
    symbol,
    seq: index + 1,
    t: new Date(last - ((count - index - 1) * 60_000)).toISOString(),
  }));
}

function nominal(symbol) {
  return {
    contract_version: MARKET_SNAPSHOT_CONTRACT_VERSION,
    instrument: symbol,
    symbol,
    ohlcv_rows: rows(500, symbol),
    depth_snapshot: { snapshot_at: new Date(NOW - 2_000).toISOString() },
    trades: [{ traded_at: new Date(NOW - 1_000).toISOString() }],
    meta: { health: { components: { ohlcv: { freshness_ms: 0 } } } },
    as_of: new Date(NOW - 1_000).toISOString(),
  };
}

for (const symbol of ["BTCUSD", "BTCUSDT"]) {
  const result = assessMarketSnapshot(nominal(symbol), { nowMs: NOW });
  assert.equal(result.state, "AVAILABLE", `${symbol} nominal`);
  assert.equal(result.valid, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(shouldUseCanonicalSnapshot(true, result), true);
}

const missingOhlcv = nominal("BTCUSDT");
delete missingOhlcv.ohlcv_rows;
assert.deepEqual(
  assessMarketSnapshot(missingOhlcv, { nowMs: NOW }).reasons,
  ["ohlcv_rows_missing"],
);
assert.equal(assessMarketSnapshot(missingOhlcv, { nowMs: NOW }).state, "UNAVAILABLE");
assert.equal(shouldUseCanonicalSnapshot(true, assessMarketSnapshot(missingOhlcv, { nowMs: NOW })), false);

const missingDepth = nominal("BTCUSDT");
delete missingDepth.depth_snapshot;
assert.equal(assessMarketSnapshot(missingDepth, { nowMs: NOW }).state, "DEGRADED");
assert.deepEqual(assessMarketSnapshot(missingDepth, { nowMs: NOW }).reasons, ["depth_snapshot_missing"]);
assert.equal(shouldUseCanonicalSnapshot(true, assessMarketSnapshot(missingDepth, { nowMs: NOW })), true);

const stale = nominal("BTCUSDT");
stale.as_of = new Date(NOW - 180_000).toISOString();
assert.equal(assessMarketSnapshot(stale, { nowMs: NOW }).state, "UNAVAILABLE");
assert.ok(assessMarketSnapshot(stale, { nowMs: NOW }).reasons.includes("snapshot_stale"));

const missingVersion = nominal("BTCUSDT");
delete missingVersion.contract_version;
assert.equal(assessMarketSnapshot(missingVersion, { nowMs: NOW }).state, "UNAVAILABLE");

assert.equal(assessMarketSnapshot([], { nowMs: NOW }).state, "UNAVAILABLE");
const malformedDepth = nominal("BTCUSDT");
malformedDepth.depth_snapshot = [];
assert.equal(assessMarketSnapshot(malformedDepth, { nowMs: NOW }).state, "DEGRADED");

const malformedOhlcvTime = nominal("BTCUSDT");
malformedOhlcvTime.ohlcv_rows = [{ seq: 1, t: "not-a-time" }];
malformedOhlcvTime.meta.health.components.ohlcv.freshness_ms = null;
assert.ok(assessMarketSnapshot(malformedOhlcvTime, { nowMs: NOW }).reasons.includes("ohlcv_timestamp_missing_or_invalid"));

console.log("market snapshot contract: 10 deterministic cases PASS");
