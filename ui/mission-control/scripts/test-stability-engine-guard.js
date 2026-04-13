const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "stabilityEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const hudTypesPath = path.join(__dirname, "..", "app", "terminal", "chartHudTypes.ts");
const hudPanelPath = path.join(__dirname, "..", "app", "terminal", "ChartHudSignalDecisionPanel.tsx");

const engineSource = fs.readFileSync(enginePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const hudTypesSource = fs.readFileSync(hudTypesPath, "utf8");
const hudPanelSource = fs.readFileSync(hudPanelPath, "utf8");

assert.match(engineSource, /export type StabilitySnapshot = \{/, "stabilityEngine must expose StabilitySnapshot");
assert.match(engineSource, /export function buildStabilitySnapshot\(/, "stabilityEngine must expose buildStabilitySnapshot()");

assert.match(pageSource, /const stabilityEngineSnapshot = useMemo\(\(\) => buildStabilitySnapshot\(/, "page.tsx must build a stability snapshot");
assert.match(pageSource, /shadowMetricsPayload/, "page.tsx must read shadow metrics for stability monitoring");
assert.match(pageSource, /externalKillSwitchPayload/, "page.tsx must read external kill-switch state");
assert.match(pageSource, /V8\.6 STAB \$\{stabilityEngineSnapshot\.mode/, "page.tsx must expose stability state in the flow banner");

assert.match(hudTypesSource, /export type StabilityEngineShape = \{/, "chartHudTypes must expose StabilityEngineShape");
assert.match(hudTypesSource, /stabilityEngine: StabilityEngineShape;/, "chartHudTypes must wire stabilityEngine into HUD props");

assert.match(hudPanelSource, /Stability Engine/, "ChartHudSignalDecisionPanel must render a Stability Engine section");
assert.match(hudPanelSource, /stabilityEngine\.monitorScorePct/, "ChartHudSignalDecisionPanel must expose stability score");

console.log("PASS stability engine guard: engine, shadow\/kill-switch wiring, HUD panel, and flow-banner exposure are present");