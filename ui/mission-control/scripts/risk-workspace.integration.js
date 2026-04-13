#!/usr/bin/env node

const assert = require("node:assert/strict");

function riskAlertDefaultsForPreset(preset) {
  if (preset === "scalp") return { window: 12, missThreshold: 4, refreshSec: 15, hardAlertEnabled: false, hardAlertThresholdPct: 60 };
  if (preset === "monitoring") return { window: 8, missThreshold: 2, refreshSec: 15, hardAlertEnabled: false, hardAlertThresholdPct: 60 };
  return { window: 10, missThreshold: 3, refreshSec: 15, hardAlertEnabled: false, hardAlertThresholdPct: 60 };
}

function normalizeRiskAlert(input, preset) {
  const defaults = riskAlertDefaultsForPreset(preset);
  const window = Number.isFinite(input?.window) ? Math.max(3, Math.min(100, Number(input.window))) : defaults.window;
  const missThresholdRaw = Number.isFinite(input?.missThreshold) ? Math.max(1, Math.min(100, Number(input.missThreshold))) : defaults.missThreshold;
  const refreshRaw = Number(input?.refreshSec);
  const refreshSec = refreshRaw === 5 || refreshRaw === 30 ? refreshRaw : 15;
  const hardAlertThresholdPctRaw = Number(input?.hardAlertThresholdPct);
  const hardAlertThresholdPct = Number.isFinite(hardAlertThresholdPctRaw)
    ? Math.max(20, Math.min(95, hardAlertThresholdPctRaw))
    : defaults.hardAlertThresholdPct;
  const hardAlertEnabled = typeof input?.hardAlertEnabled === "boolean"
    ? input.hardAlertEnabled
    : defaults.hardAlertEnabled;
  return {
    window,
    missThreshold: Math.min(window, missThresholdRaw),
    refreshSec,
    hardAlertEnabled,
    hardAlertThresholdPct,
  };
}

function resetRiskAlertForWorkspace(layout) {
  return {
    ...layout,
    riskAlert: riskAlertDefaultsForPreset(layout.preset),
  };
}

function run() {
  const storage = new Map();
  const key = "txt.terminal.workspaces.v1.mt5-demo-01";

  const initial = {
    active: "Scalp-1",
    workspaces: {
      "Scalp-1": { preset: "scalp", riskAlert: { window: 12, missThreshold: 4, refreshSec: 15, hardAlertEnabled: false, hardAlertThresholdPct: 60 } },
      "Swing-NY": { preset: "swing", riskAlert: { window: 10, missThreshold: 3, refreshSec: 15, hardAlertEnabled: false, hardAlertThresholdPct: 60 } },
    },
  };
  storage.set(key, JSON.stringify(initial));

  // 1) Workspace change
  const afterSwitch = JSON.parse(storage.get(key));
  afterSwitch.active = "Swing-NY";
  storage.set(key, JSON.stringify(afterSwitch));

  // 2) User customization then reset on active workspace
  const customized = JSON.parse(storage.get(key));
  customized.workspaces["Swing-NY"].riskAlert = normalizeRiskAlert({ window: 19, missThreshold: 7, refreshSec: 30, hardAlertEnabled: true, hardAlertThresholdPct: 72 }, "swing");
  storage.set(key, JSON.stringify(customized));

  const resetPayload = JSON.parse(storage.get(key));
  resetPayload.workspaces["Swing-NY"] = resetRiskAlertForWorkspace(resetPayload.workspaces["Swing-NY"]);
  storage.set(key, JSON.stringify(resetPayload));

  // 3) Persist + reload simulation
  const reloaded = JSON.parse(storage.get(key));
  const activeLayout = reloaded.workspaces[reloaded.active];
  const restored = normalizeRiskAlert(activeLayout.riskAlert, activeLayout.preset);

  assert.equal(reloaded.active, "Swing-NY", "active workspace should persist");
  assert.equal(restored.window, 10, "reset should restore swing window to 10");
  assert.equal(restored.missThreshold, 3, "reset should restore swing threshold to 3");
  assert.equal(restored.refreshSec, 15, "refresh should be valid and persisted");
  assert.equal(restored.hardAlertEnabled, false, "reset should restore hard-alert toggle for swing");
  assert.equal(restored.hardAlertThresholdPct, 60, "reset should restore hard-alert threshold for swing");

  console.log("PASS risk-workspace integration: change -> reset -> persist -> reload");
}

try {
  run();
} catch (error) {
  console.error("FAIL risk-workspace integration", error);
  process.exit(1);
}
