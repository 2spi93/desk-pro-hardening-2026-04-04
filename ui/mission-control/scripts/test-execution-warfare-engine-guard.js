const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "executionWarfareEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const hudTypesPath = path.join(__dirname, "..", "app", "terminal", "chartHudTypes.ts");
const hudPanelPath = path.join(__dirname, "..", "app", "terminal", "ChartHudSignalDecisionPanel.tsx");

const engineSource = fs.readFileSync(enginePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const hudTypesSource = fs.readFileSync(hudTypesPath, "utf8");
const hudPanelSource = fs.readFileSync(hudPanelPath, "utf8");

assert.match(engineSource, /export type ExecutionWarfareSnapshot = \{/, "executionWarfareEngine must expose ExecutionWarfareSnapshot");
assert.match(engineSource, /export function detectLiquidityTrap\(/, "executionWarfareEngine must expose detectLiquidityTrap()");
assert.match(engineSource, /export function executionGuard\(/, "executionWarfareEngine must expose executionGuard()");
assert.match(engineSource, /export function executionWarfareEngine\(/, "executionWarfareEngine must expose executionWarfareEngine()");
assert.match(engineSource, /export function sliceOrder\(/, "executionWarfareEngine must expose sliceOrder()");

assert.match(pageSource, /const executionWarfareV85Snapshot = useMemo\(\(\) => \{/, "page.tsx must build a V8.5 warfare snapshot");
assert.match(pageSource, /async function executeWarfareTradeTicket\(/, "page.tsx must route ticket sends through a V8.5 warfare executor");
assert.match(pageSource, /execution_warfare_mode:/, "page.tsx must send warfare metadata with orders");
assert.match(pageSource, /V8\.5 \$\{executionWarfareV85Snapshot\.plan\.mode\}/, "page.tsx must expose the V8.5 state in the flow banner");

assert.match(hudTypesSource, /export type ExecutionWarfareShape = \{/, "chartHudTypes must expose ExecutionWarfareShape");
assert.match(hudTypesSource, /executionWarfare: ExecutionWarfareShape;/, "chartHudTypes must wire executionWarfare into HUD props");

assert.match(hudPanelSource, /V8\.5 Execution Warfare/, "ChartHudSignalDecisionPanel must render a dedicated V8.5 warfare section");
assert.match(hudPanelSource, /executionWarfare\.executionScorePct/, "ChartHudSignalDecisionPanel must expose warfare execution score");

console.log("PASS execution warfare V8.5 guard: engine, live slicing, HUD panel, and flow-banner exposure are present");