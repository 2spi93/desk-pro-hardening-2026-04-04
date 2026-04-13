const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "strategyEvolutionEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const hudTypesPath = path.join(__dirname, "..", "app", "terminal", "chartHudTypes.ts");
const hudPanelPath = path.join(__dirname, "..", "app", "terminal", "ChartHudSignalDecisionPanel.tsx");

const engineSource = fs.readFileSync(enginePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const hudTypesSource = fs.readFileSync(hudTypesPath, "utf8");
const hudPanelSource = fs.readFileSync(hudPanelPath, "utf8");

assert.match(engineSource, /export type StrategyEvolutionSnapshot = \{/, "strategyEvolutionEngine must expose StrategyEvolutionSnapshot");
assert.match(engineSource, /export function buildStrategyEvolutionSnapshot\(/, "strategyEvolutionEngine must expose buildStrategyEvolutionSnapshot()");

assert.match(pageSource, /const strategyEvolutionV9Snapshot = useMemo\(\(\) => buildStrategyEvolutionSnapshot\(/, "page.tsx must build a V9 strategy evolution snapshot");
assert.match(pageSource, /strategy_evolution:/, "page.tsx must send V9 strategy-evolution intent metadata with orders");
assert.match(pageSource, /V9 \$\{strategyEvolutionV9Snapshot\.capitalMode/, "page.tsx must expose V9 state in the flow banner");

assert.match(hudTypesSource, /export type StrategyEvolutionShape = \{/, "chartHudTypes must expose StrategyEvolutionShape");
assert.match(hudTypesSource, /strategyEvolution: StrategyEvolutionShape;/, "chartHudTypes must wire strategyEvolution into HUD props");

assert.match(hudPanelSource, /V9 Strategy Evolution/, "ChartHudSignalDecisionPanel must render a V9 section");
assert.match(hudPanelSource, /strategyEvolution\.allocationPills/, "ChartHudSignalDecisionPanel must expose V9 capital allocation pills");

console.log("PASS strategy evolution guard: engine, metadata wiring, HUD panel, and flow-banner exposure are present");