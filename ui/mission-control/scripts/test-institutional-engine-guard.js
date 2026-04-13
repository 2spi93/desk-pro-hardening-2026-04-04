const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "institutionalEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const hudTypesPath = path.join(__dirname, "..", "app", "terminal", "chartHudTypes.ts");
const hudPanelPath = path.join(__dirname, "..", "app", "terminal", "ChartHudSignalDecisionPanel.tsx");

const engineSource = fs.readFileSync(enginePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const hudTypesSource = fs.readFileSync(hudTypesPath, "utf8");
const hudPanelSource = fs.readFileSync(hudPanelPath, "utf8");

assert.match(engineSource, /export type SelfHealingSnapshot = \{/, "institutionalEngine must expose SelfHealingSnapshot");
assert.match(engineSource, /export function buildSelfHealingSnapshot\(/, "institutionalEngine must expose buildSelfHealingSnapshot()");
assert.match(engineSource, /export function buildInstitutionalSnapshot\(/, "institutionalEngine must expose buildInstitutionalSnapshot()");
assert.match(engineSource, /export function smartKillSwitch\(/, "institutionalEngine must expose smartKillSwitch()");

assert.match(pageSource, /const selfHealingV75Snapshot = useMemo\(\(\) => buildSelfHealingSnapshot\(/, "page.tsx must build a V7.5 self-healing snapshot");
assert.match(pageSource, /const institutionalV8Snapshot = useMemo\(\(\) => buildInstitutionalSnapshot\(/, "page.tsx must build a V8 institutional snapshot");
assert.match(pageSource, /const institutionalExecutionSizeMultiplier = clamp\(/, "page.tsx must derive an effective institutional sizing multiplier");
assert.match(pageSource, /notional: effectiveNotional,/, "page.tsx must send the effective institutional notional in chart orders");
assert.match(pageSource, /notionalUsd: arbNotional,/, "page.tsx must send the effective institutional notional in V7 arbitrage orders");
assert.match(pageSource, /V7\.5 \$\{selfHealingV75Snapshot\.action\}/, "page.tsx must expose the V7.5 state in the flow banner");
assert.match(pageSource, /V8 \$\{institutionalV8Snapshot\.selectedAgent/, "page.tsx must expose the V8 state in the flow banner");

assert.match(hudTypesSource, /export type InstitutionalHealingShape = \{/, "chartHudTypes must expose InstitutionalHealingShape");
assert.match(hudTypesSource, /institutionalHealing: InstitutionalHealingShape;/, "chartHudTypes must wire institutionalHealing into HUD props");
assert.match(hudTypesSource, /institutionalSnapshot: InstitutionalSnapshotShape;/, "chartHudTypes must wire institutionalSnapshot into HUD props");

assert.match(hudPanelSource, /V7\.5 \+ V8 Institutional/, "ChartHudSignalDecisionPanel must render a dedicated V7.5/V8 institutional section");
assert.match(hudPanelSource, /institutionalSnapshot\.capitalAllocationPills/, "ChartHudSignalDecisionPanel must expose capital allocation pills");

console.log("PASS institutional engine guard: self-healing, institutional sizing, HUD panel, and flow-banner exposure are present");