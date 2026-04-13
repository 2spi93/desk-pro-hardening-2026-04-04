import assert from "node:assert/strict";

import { buildLiquidityOverlayZones, detectLiquidity } from "../../app/terminal/liquidityEngine";
import { buildStructureOverlayZones, detectStructure } from "../../app/terminal/structureEngine";

const candles = [
  { label: "2026-04-12T09:00:00.000Z", open: 100, high: 102, low: 99.5, close: 101.7, volume: 12 },
  { label: "2026-04-12T09:01:00.000Z", open: 101.7, high: 101.9, low: 100.6, close: 101.1, volume: 9 },
  { label: "2026-04-12T09:02:00.000Z", open: 101.1, high: 103.4, low: 100.9, close: 103.1, volume: 18 },
  { label: "2026-04-12T09:03:00.000Z", open: 103.1, high: 103.2, low: 101.8, close: 102.2, volume: 10 },
  { label: "2026-04-12T09:04:00.000Z", open: 102.2, high: 104.2, low: 102.0, close: 103.9, volume: 22 },
  { label: "2026-04-12T09:05:00.000Z", open: 103.9, high: 104.0, low: 102.7, close: 103.2, volume: 11 },
  { label: "2026-04-12T09:06:00.000Z", open: 103.2, high: 105.05, low: 103.0, close: 104.8, volume: 26 },
  { label: "2026-04-12T09:07:00.000Z", open: 104.8, high: 105.1, low: 103.1, close: 103.3, volume: 20 },
  { label: "2026-04-12T09:08:00.000Z", open: 103.3, high: 104.4, low: 102.8, close: 104.0, volume: 17 },
  { label: "2026-04-12T09:09:00.000Z", open: 104.0, high: 105.45, low: 103.9, close: 104.2, volume: 24 },
  { label: "2026-04-12T09:10:00.000Z", open: 104.2, high: 105.6, low: 103.8, close: 103.95, volume: 25 },
];

const structure = detectStructure(candles);
assert.equal(structure.state, "trend-up", "HH/HL progression should resolve as an uptrend");
assert.ok(structure.impulseScore > 0.45, "trend structure should expose a meaningful impulse score");

const structureZones = buildStructureOverlayZones(structure);
assert.ok(structureZones.length > 0, "structure engine should emit overlay zones");
assert.ok(structureZones.some((zone) => /structure/i.test(zone.label)), "structure overlays should be labeled explicitly");

const liquidity = detectLiquidity(candles, structure);
assert.ok(liquidity.equalHighs.length > 0, "equal highs should be clustered as liquidity");
assert.equal(liquidity.fakeBreakoutRisk, true, "sweep and rejection above equal highs should flag fake breakout risk");

const liquidityZones = buildLiquidityOverlayZones(liquidity);
assert.ok(liquidityZones.some((zone) => /equal highs/i.test(zone.label)), "liquidity overlays should expose equal highs");
assert.ok(liquidityZones.some((zone) => /sweep/i.test(zone.label)), "liquidity overlays should expose sweep rejection risk");

console.log("PASS structure-liquidity regression: structure trend and liquidity sweep detection are exported as overlays");