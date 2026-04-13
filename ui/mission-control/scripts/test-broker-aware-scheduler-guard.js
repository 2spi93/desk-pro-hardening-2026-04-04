const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const enginePath = path.join(__dirname, "..", "app", "terminal", "executionSchedulerEngine.ts");
const pagePath = path.join(__dirname, "..", "app", "terminal", "page.tsx");
const cancelRoutePath = path.join(__dirname, "..", "app", "api", "live", "orders", "cancel", "route.ts");
const hudTypesPath = path.join(__dirname, "..", "app", "terminal", "chartHudTypes.ts");
const hudPanelPath = path.join(__dirname, "..", "app", "terminal", "ChartHudSignalDecisionPanel.tsx");
const connectorsPagePath = path.join(__dirname, "..", "app", "connectors", "page.tsx");
const uiSpecPath = path.join(__dirname, "..", "tests", "e2e", "terminal-cancel-replace-ui.spec.ts");

const engineSource = fs.readFileSync(enginePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const cancelRouteSource = fs.readFileSync(cancelRoutePath, "utf8");
const hudTypesSource = fs.readFileSync(hudTypesPath, "utf8");
const hudPanelSource = fs.readFileSync(hudPanelPath, "utf8");
const connectorsPageSource = fs.readFileSync(connectorsPagePath, "utf8");
const uiSpecSource = fs.readFileSync(uiSpecPath, "utf8");

assert.match(engineSource, /export type BrokerAwareSchedulerSnapshot = \{/, "executionSchedulerEngine must expose BrokerAwareSchedulerSnapshot");
assert.match(engineSource, /export function deriveChildOrderLifecycle\(/, "executionSchedulerEngine must expose deriveChildOrderLifecycle()");
assert.match(engineSource, /export function scheduleChildOrders\(/, "executionSchedulerEngine must expose scheduleChildOrders()");
assert.match(engineSource, /export function buildBrokerAwareSchedulerSnapshot\(/, "executionSchedulerEngine must expose buildBrokerAwareSchedulerSnapshot()");
assert.match(engineSource, /supportsModify: boolean;/, "executionSchedulerEngine must expose broker modify capability input");
assert.match(engineSource, /supportsCancelReplace: boolean;/, "executionSchedulerEngine must expose broker cancel\/replace capability input");
assert.match(engineSource, /replaceStrategy: BrokerAwareReplaceStrategy;/, "executionSchedulerEngine must expose replace strategy in the snapshot");

assert.match(pageSource, /const brokerAwareSchedulerV851Snapshot = useMemo\(\(\) => buildBrokerAwareSchedulerSnapshot\(/, "page.tsx must build a V8.5.1 scheduler snapshot");
assert.match(pageSource, /broker_aware_scheduler:/, "page.tsx must send broker-aware scheduler intent metadata with orders");
assert.match(pageSource, /fetch\("\/api\/live\/orders\/cancel"/, "page.tsx must call the live cancel proxy for cancel\/replace flows");
assert.match(pageSource, /V8\.5\.1 \$\{brokerAwareSchedulerV851Snapshot\.action\}/, "page.tsx must expose V8.5.1 state in the flow banner");
assert.match(pageSource, /selectedBrokerCapabilities/, "page.tsx must resolve broker capability flags before building the scheduler snapshot");
assert.match(pageSource, /supports_cancel_replace/, "page.tsx must propagate cancel\/replace capability metadata into order intent or results");

assert.match(cancelRouteSource, /cpFetchJsonSafe\("\/v1\/live\/orders\/cancel"/, "UI live cancel route must proxy to the control-plane cancel endpoint");

assert.match(hudTypesSource, /export type BrokerAwareSchedulerShape = \{/, "chartHudTypes must expose BrokerAwareSchedulerShape");
assert.match(hudTypesSource, /brokerAwareScheduler: BrokerAwareSchedulerShape;/, "chartHudTypes must wire brokerAwareScheduler into HUD props");
assert.match(hudTypesSource, /supportsModify: boolean;/, "chartHudTypes must expose modify capability in the HUD shape");
assert.match(hudTypesSource, /supportsCancelReplace: boolean;/, "chartHudTypes must expose cancel\/replace capability in the HUD shape");

assert.match(hudPanelSource, /V8\.5\.1 Broker Scheduler/, "ChartHudSignalDecisionPanel must render a V8.5.1 scheduler section");
assert.match(hudPanelSource, /brokerAwareScheduler\.scheduleScorePct/, "ChartHudSignalDecisionPanel must expose scheduler score");
assert.match(hudPanelSource, /cancel\/replace/, "ChartHudSignalDecisionPanel must render capability state for cancel\/replace");

assert.match(connectorsPageSource, /Broker Capability Desk/, "connectors page must expose a dedicated broker capability operator view");
assert.match(connectorsPageSource, /broker_capabilities/, "connectors page must read broker_capabilities from linked accounts");
assert.match(connectorsPageSource, /Matrice Compte - Replace Strategy/, "connectors page must render a per-account replace strategy matrix");

assert.match(uiSpecSource, /e2eScheduler=cancel-replace/, "UI cancel\/replace Playwright spec must force the CANCEL_REPLACE scheduler scenario through /terminal");
assert.match(uiSpecSource, /Send Order/, "UI cancel\/replace Playwright spec must click through the terminal send control");

console.log("PASS broker-aware scheduler guard: engine, metadata wiring, HUD panel, connectors operator view, and flow-banner exposure are present");