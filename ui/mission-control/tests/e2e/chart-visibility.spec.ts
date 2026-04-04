import { expect, test } from "@playwright/test";
import { analyzeChartScreenshot } from "./helpers/chart";
import { loginIfRequired } from "./helpers/terminal";

test("@chart terminal chart keeps visible candles after auth refresh cycles", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  await loginIfRequired(page, "/terminal", "chart visibility test");

  const chart = page.locator(".chart-canvas-host").first();
  await chart.waitFor({ state: "visible", timeout: 45_000 });
  await expect(chart.locator("canvas").first()).toBeAttached({ timeout: 45_000 });

  const signalChip = page.locator(".chart-system-chip, .chart-overlay-chip, .chart-system-badge").filter({
    hasText: /VWAP|Range|Liquidity/i,
  }).first();
  await expect(signalChip).toBeVisible({ timeout: 45_000 });

  let finalStats: Awaited<ReturnType<typeof analyzeChartScreenshot>> | null = null;
  await expect.poll(async () => {
    const stats = await analyzeChartScreenshot(page, chart);
    if (stats.accentPixels > 150) {
      finalStats = stats;
    }
    return stats.accentPixels;
  }, { timeout: 45_000, intervals: [1000, 2000, 3000] }).toBeGreaterThan(150);

  if (!finalStats) {
    finalStats = await analyzeChartScreenshot(page, chart);
  }
  await chart.scrollIntoViewIfNeeded();
  const chartBox = await chart.boundingBox();
  if (chartBox) {
    await page.screenshot({
      path: testInfo.outputPath("chart-visibility.png"),
      clip: {
        x: Math.max(0, chartBox.x),
        y: Math.max(0, chartBox.y),
        width: Math.max(1, chartBox.width),
        height: Math.max(1, chartBox.height),
      },
    });
  }

  expect(finalStats.nonBackgroundPixels).toBeGreaterThan(1200);
  expect(finalStats.accentPixels).toBeGreaterThan(150);
  expect(finalStats.colorBuckets).toBeGreaterThan(5);
  expect(finalStats.bullishPixels + finalStats.bearishPixels).toBeGreaterThan(120);
});