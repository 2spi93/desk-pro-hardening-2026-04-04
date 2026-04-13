const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "adaptiveEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");

const engineSource = fs.readFileSync(enginePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");

assert.match(engineSource, /export type AdaptiveState = \{/, "adaptiveEngine must expose AdaptiveState");
assert.match(engineSource, /export function updateModel\(/, "adaptiveEngine must expose updateModel()");
assert.match(engineSource, /export function applyRealityCorrection\(/, "adaptiveEngine must expose applyRealityCorrection()");
assert.match(engineSource, /export function mutateStrategy\(/, "adaptiveEngine must expose mutateStrategy()");
assert.match(engineSource, /export function detectRegime\(/, "adaptiveEngine must expose detectRegime()");
assert.match(engineSource, /export function metaLearning\(/, "adaptiveEngine must expose metaLearning()");
assert.match(engineSource, /export function dynamicRisk\(/, "adaptiveEngine must expose dynamicRisk()");
assert.match(engineSource, /export function buildAdaptiveSnapshot\(/, "adaptiveEngine must expose buildAdaptiveSnapshot()");

assert.match(pageSource, /const \[realityGapRecentRows, setRealityGapRecentRows\] = useState<JsonMap\[]>\(\[\]\);/, "page.tsx must hold recent reality-gap rows for adaptive learning");
assert.match(pageSource, /fetch\("\/api\/execution\/reality-gap\/recent\?limit=24"/, "page.tsx must poll recent reality-gap samples");
assert.match(pageSource, /const adaptiveV7Snapshot = useMemo\(\(\) => buildAdaptiveSnapshot\(/, "page.tsx must build an adaptive V7 snapshot");
assert.match(pageSource, /adaptiveV7Snapshot\.decision\.action === "skip" \|\| adaptiveV7Snapshot\.decision\.action === "hold"/, "page.tsx must let the adaptive V7 layer block execution when confidence or reality gap degrades");
assert.match(pageSource, /V7A \$\{adaptiveV7Snapshot\.decision\.action\.toUpperCase\(\)\}/, "page.tsx must expose the adaptive V7 decision in the flow banner");

console.log("PASS adaptive engine V7 guard: adaptive engine, reality-gap polling, execution gating, and flow-banner exposure are present");