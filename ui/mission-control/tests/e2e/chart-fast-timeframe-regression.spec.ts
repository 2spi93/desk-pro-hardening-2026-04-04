import { expect, test } from "@playwright/test";
import { analyzeChartScreenshot } from "./helpers/chart";
import { loginIfRequired } from "./helpers/terminal";

const FAST_TIMEFRAMES = ["1s", "10s", "30s", "1m"] as const;

async function captureSettledChartStats(
  page: Parameters<typeof analyzeChartScreenshot>[0],
  chart: Parameters<typeof analyzeChartScreenshot>[1],
  timeframe: string,
) {
  let lastStats: Awaited<ReturnType<typeof analyzeChartScreenshot>> | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastStats = await analyzeChartScreenshot(page, chart);
    if (lastStats.accentPixels > 120) {
      return lastStats;
    }
    await page.waitForTimeout(1_500 + attempt * 750);
  }

  throw new Error(`Chart did not repaint for ${timeframe}; last accentPixels=${lastStats?.accentPixels ?? -1}`);
}

test("@chart terminal fast timeframes keep the chart visible and alive", async ({ page }, testInfo) => {
  test.setTimeout(180_000);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await loginIfRequired(page, "/terminal", "fast timeframe regression");

  const chart = page.locator(".chart-canvas-host").first();
  await chart.waitFor({ state: "visible", timeout: 45_000 });

  for (const timeframe of FAST_TIMEFRAMES) {
    const button = page.getByRole("button", { name: new RegExp(`^${timeframe}$`) }).first();
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await expect(chart).toBeVisible({ timeout: 15_000 });
    await expect(chart.locator("canvas").first()).toBeAttached({ timeout: 15_000 });
    await expect(page.locator(".chart-meta-strip .chart-overlay-chip").filter({ hasText: new RegExp(`^${timeframe}$`) }).first()).toBeVisible({ timeout: 15_000 });
    await page.locator(".chart-loader").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(750);

    const box = await chart.boundingBox();
    expect(box?.width || 0).toBeGreaterThan(320);
    expect(box?.height || 0).toBeGreaterThan(220);

    const stats = await captureSettledChartStats(page, chart, timeframe);

    expect(stats.nonBackgroundPixels).toBeGreaterThan(1000);
    expect(stats.accentPixels).toBeGreaterThan(120);
    expect(stats.colorBuckets).toBeGreaterThan(4);
  }

  expect(pageErrors).toEqual([]);
});