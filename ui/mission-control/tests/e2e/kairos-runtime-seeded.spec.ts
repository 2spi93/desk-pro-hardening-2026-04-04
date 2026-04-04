import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

const HOT_COMPUTE_LABELS = [
  "selectedChartMetric",
  "renderableOhlcvBars",
  "localOhlcvAnalysis",
  "nativeTradeVolume30s",
  "microBurstTrades10ms",
  "chartSeriesForAnchors",
  "multiAnchorVwap",
  "predictorOrderbookSignals",
  "predictorOrderflowSnapshot",
];

async function seedKairosHarnessReplay(page: Parameters<typeof test>[0]["page"]) {
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/execution/replay/seed/kairos-harness", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: "SOLUSDT",
        venue: "bingx",
        validation_source: "playwright-seeded-smoke",
        apply_calibration: false,
        train_brain: false,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload };
  });

  return {
    ok: result.ok,
    status: Number(result.status || 0),
    degraded: Boolean(result.payload?.degraded_flag) || String(result.payload?.network_state || "") === "degraded",
    decisionId: String(result.payload?.decision_id || ""),
    validationSource: String(result.payload?.harness?.validation_source || ""),
  };
}

async function snapshotTerminalComputePerf(page: Parameters<typeof test>[0]["page"]) {
  return page.evaluate(() => {
    const store = (window as Window & {
      __MC_TERMINAL_COMPUTE_PERF__?: {
        entries?: Record<string, { count: number; totalMs: number; maxMs: number; lastMs: number; lastAt: number }>;
      };
    }).__MC_TERMINAL_COMPUTE_PERF__;
    if (!store?.entries) {
      return [] as Array<{ label: string; count: number; totalMs: number; avgMs: number; maxMs: number; lastMs: number; lastAt: string | null }>;
    }
    const round = (value: number) => Number(value.toFixed(3));
    return Object.entries(store.entries)
      .map(([label, entry]) => ({
        label,
        count: Number(entry.count || 0),
        totalMs: round(Number(entry.totalMs || 0)),
        avgMs: round(Number(entry.totalMs || 0) / Math.max(Number(entry.count || 0), 1)),
        maxMs: round(Number(entry.maxMs || 0)),
        lastMs: round(Number(entry.lastMs || 0)),
        lastAt: entry.lastAt ? new Date(entry.lastAt).toISOString() : null,
      }))
      .sort((left, right) => {
        if (right.totalMs !== left.totalMs) {
          return right.totalMs - left.totalMs;
        }
        if (right.maxMs !== left.maxMs) {
          return right.maxMs - left.maxMs;
        }
        return right.count - left.count;
      })
      .slice(0, 6);
  });
}

async function fetchRecentRealityGapRows(page: Parameters<typeof test>[0]["page"]) {
  return page.evaluate(async () => {
    const response = await fetch("/api/execution/reality-gap/recent?limit=24", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.rows)
        ? payload.rows
        : [];
    return rows.map((row) => ({
      decisionId: String(row?.decision_id || ""),
      symbol: String(row?.symbol || row?.instrument || ""),
      venue: String(row?.venue || ""),
    }));
  });
}

test("seeded Kairos runtime smoke populates reality gap and terminal perf telemetry", async ({ page }) => {
  test.setTimeout(120_000);

  await loginIfRequired(page, "/terminal?v2=1&perfDebug=1", "seeded Kairos runtime smoke");

  const seed = await seedKairosHarnessReplay(page);
  test.skip(seed.degraded, "Kairos harness seed requires a reachable control plane when MC_E2E_DEV_DEGRADED returns degraded responses");
  expect(seed.ok, `Synthetic replay seed failed (${seed.status})`).toBeTruthy();

  await expect.poll(async () => {
    const rows = await fetchRecentRealityGapRows(page);
    return rows.some((row) => row.decisionId === seed.decisionId);
  }, { timeout: 30_000 }).toBeTruthy();

  await page.goto("/advanced/reality-gap", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Reality Gap", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("body")).toContainText("Kairos Harness");
  await expect(page.locator("body")).toContainText("Validation source");

  await page.goto("/terminal?v2=1&perfDebug=1", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Live Focus", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("terminal-compute-perf-toggle")).toContainText("CPU ON");
  await page.waitForTimeout(2500);
  await expect.poll(async () => (await snapshotTerminalComputePerf(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);

  const perfSnapshot = await snapshotTerminalComputePerf(page);
  expect(perfSnapshot.length).toBeGreaterThan(0);
  expect(perfSnapshot.some((entry) => HOT_COMPUTE_LABELS.includes(entry.label))).toBeTruthy();
  await expect(page.getByTestId("terminal-compute-perf-summary")).toBeVisible();
});