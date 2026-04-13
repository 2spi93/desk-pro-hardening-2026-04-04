import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { analyzeChartScreenshot } from "./helpers/chart";
import { loginIfRequired } from "./helpers/terminal";

const TARGET_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
const ARTIFACT_DIR = path.join(process.cwd(), "..", "..", "artifacts", "ui-smoke", "chart-perception-v3");

type RuntimePerceptualTelemetry = {
  timeframe: string;
  densityLevel: string;
  visibleBars: number;
  candleStepPx: number;
  spacing: {
    profile: string;
    barSpacing: number;
    targetVisibleBars: number;
    minGapPx: number;
  };
  pixel: {
    pixelRatio: number;
    rawSpacingPx: number;
    quantizedSpacingPx: number;
    snapDeltaPx: number;
    spacingZone: "micro" | "normal" | "macro";
    preferredBodyWidthPx: number;
    wickWidthPx: number;
    overlayWidthPx: number;
    bodyRadiusPx: number;
  };
  updatedAt: string;
};

async function captureRuntimePerceptualTelemetry(page: Page): Promise<RuntimePerceptualTelemetry | null> {
  return page.locator(".chart-canvas-host").first().evaluate((node) => {
    const rawTelemetry = node.getAttribute("data-chart-perceptual-telemetry");
    if (rawTelemetry) {
      try {
        return JSON.parse(rawTelemetry) as RuntimePerceptualTelemetry;
      } catch {
        // Fall through to the global runtime channel if the DOM payload is transient.
      }
    }

    const runtimeWindow = window as Window & {
      __MC_CHART_PERCEPTUAL_TELEMETRY__?: RuntimePerceptualTelemetry | null;
    };
    return runtimeWindow.__MC_CHART_PERCEPTUAL_TELEMETRY__ ?? null;
  });
}

async function waitForRuntimePerceptualTelemetry(page: Page, timeframe: string): Promise<RuntimePerceptualTelemetry | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const telemetry = await captureRuntimePerceptualTelemetry(page);
    if (telemetry && telemetry.timeframe === timeframe) {
      return telemetry;
    }
    await page.waitForTimeout(300 + attempt * 150);
  }
  return null;
}

async function captureSettledChartStats(page: Page, timeframe: string) {
  const chart = page.locator(".chart-canvas-host").first();
  let lastStats: Awaited<ReturnType<typeof analyzeChartScreenshot>> | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastStats = await analyzeChartScreenshot(page, chart);
    if (lastStats.accentPixels > 140 && lastStats.nonBackgroundPixels > 1200 && lastStats.colorBuckets >= 5) {
      return lastStats;
    }
    await page.waitForTimeout(1200 + attempt * 600);
  }

  throw new Error(`Chart did not settle visually for ${timeframe}; last accentPixels=${lastStats?.accentPixels ?? -1}`);
}

test("@chart terminal multi-timeframe visual smoke keeps x-scale stable across desk timeframes", async ({ page }) => {
  test.setTimeout(240_000);
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await loginIfRequired(page, "/terminal?v2=1&engine=v3", "multi-timeframe visual smoke");

  const chart = page.locator(".chart-canvas-host").first();
  await chart.waitFor({ state: "visible", timeout: 45_000 });

  let previousWidth = 0;
  const artifactRows: Array<{ timeframe: string; stats: Awaited<ReturnType<typeof analyzeChartScreenshot>>; telemetry: RuntimePerceptualTelemetry | null; screenshot: string }> = [];

  for (const timeframe of TARGET_TIMEFRAMES) {
    const button = page.getByRole("button", { name: new RegExp(`^${timeframe}$`) }).first();
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
    await expect(page.locator(".chart-meta-strip .chart-overlay-chip").filter({ hasText: new RegExp(`^${timeframe}$`) }).first()).toBeVisible({ timeout: 15_000 });
    await page.locator(".chart-loader").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(900);

    const stats = await captureSettledChartStats(page, timeframe);
    const telemetry = await waitForRuntimePerceptualTelemetry(page, timeframe);
    const screenshotFile = path.join(ARTIFACT_DIR, `chart-perception-${timeframe}.png`);
    await chart.screenshot({ path: screenshotFile });

    expect(stats.width).toBeGreaterThan(320);
    expect(stats.height).toBeGreaterThan(220);
    expect(stats.nonBackgroundPixels).toBeGreaterThan(1200);
    expect(stats.accentPixels).toBeGreaterThan(140);
    expect(stats.colorBuckets).toBeGreaterThanOrEqual(5);
    expect(telemetry).not.toBeNull();
    expect(telemetry?.timeframe).toBe(timeframe);
    expect(telemetry?.pixel.quantizedSpacingPx || 0).toBeGreaterThanOrEqual(2);
    expect(Math.abs(telemetry?.pixel.snapDeltaPx || 0)).toBeLessThanOrEqual(2.2);

    if (previousWidth > 0) {
      expect(Math.abs(stats.width - previousWidth)).toBeLessThan(4);
    }
    previousWidth = stats.width;
    artifactRows.push({
      timeframe,
      stats,
      telemetry,
      screenshot: path.relative(path.join(process.cwd(), "..", ".."), screenshotFile),
    });
  }

  await writeFile(
    path.join(ARTIFACT_DIR, "chart-perception-summary.json"),
    `${JSON.stringify({ capturedAt: new Date().toISOString(), rows: artifactRows }, null, 2)}\n`,
    "utf8",
  );

  expect(pageErrors).toEqual([]);
});