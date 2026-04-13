import { expect, test, type Locator, type Page } from "@playwright/test";

import { EXPECTED_VISIBLE_TIMEFRAMES, escapeRegExp, loginIfRequired } from "./helpers/terminal";

type GpuCameraState = {
  timeframe: string;
  panMode: string;
  visibleBars: number;
  from: number;
  to: number;
};

async function readGpuCameraState(chart: Locator): Promise<GpuCameraState> {
  return chart.evaluate((node) => {
    const readNumber = (name: string) => Number(node.getAttribute(name) || 0);
    return {
      timeframe: String(node.getAttribute("data-gpu-timeframe") || ""),
      panMode: String(node.getAttribute("data-gpu-pan-mode") || ""),
      visibleBars: readNumber("data-gpu-visible-bars"),
      from: readNumber("data-gpu-camera-from"),
      to: readNumber("data-gpu-camera-to"),
    };
  });
}

async function waitForGpuCameraState(
  chart: Locator,
  predicate: (state: GpuCameraState) => boolean,
  timeoutMs = 8_000,
): Promise<GpuCameraState> {
  const start = Date.now();
  let lastState = await readGpuCameraState(chart);

  while (Date.now() - start < timeoutMs) {
    if (predicate(lastState)) {
      return lastState;
    }
    await chart.page().waitForTimeout(180);
    lastState = await readGpuCameraState(chart);
  }

  throw new Error(`GPU camera state did not satisfy predicate in time: ${JSON.stringify(lastState)}`);
}

async function settleTimeframe(page: Page, timeframe: string, chart: Locator): Promise<GpuCameraState> {
  const button = page.getByRole("button", { name: new RegExp(`^${escapeRegExp(timeframe)}$`) }).first();
  await expect(button).toBeVisible({ timeout: 45_000 });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  await page.locator(".chart-loader").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await chart.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(900);
  return waitForGpuCameraState(chart, (state) => state.timeframe === timeframe && state.visibleBars >= 8 && state.to > state.from);
}

async function readCanvasMetrics(canvas: Locator): Promise<{ width: number; height: number }> {
  return canvas.evaluate((node) => ({
    width: node.clientWidth,
    height: node.clientHeight,
  }));
}

async function zoomChartWithToolbar(
  page: Page,
  chart: Locator,
  timeframe: string,
  initialVisibleBars: number,
): Promise<GpuCameraState> {
  const zoomInButton = page.getByRole("button", { name: /^Zoom \+$/ }).first();
  await expect(zoomInButton).toBeVisible({ timeout: 15_000 });
  await zoomInButton.click();
  return waitForGpuCameraState(
    chart,
    (state) => state.timeframe === timeframe && state.visibleBars >= 8 && Math.abs(state.visibleBars - initialVisibleBars) >= 2,
    6_000,
  );
}

async function expandDatasetForPan(page: Page, chart: Locator, timeframe: string, currentVisibleBars: number): Promise<GpuCameraState> {
  const zoomOutButton = page.getByRole("button", { name: /^Zoom −$/ }).first();
  await expect(zoomOutButton).toBeVisible({ timeout: 15_000 });
  await zoomOutButton.click();
  return waitForGpuCameraState(
    chart,
    (state) => state.timeframe === timeframe && state.visibleBars === currentVisibleBars && state.from > 0,
    6_000,
  );
}

async function panChartLeftDrag(canvas: Locator, startX: number, startY: number, endX: number, endY: number): Promise<void> {
  await canvas.evaluate((node, payload) => {
    node.dispatchEvent(new MouseEvent("mousedown", {
      button: 0,
      buttons: 1,
      clientX: payload.startX,
      clientY: payload.startY,
      bubbles: true,
      cancelable: true,
    }));

    const steps = 10;
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps;
      const clientX = payload.startX + (payload.endX - payload.startX) * ratio;
      const clientY = payload.startY + (payload.endY - payload.startY) * ratio;
      window.dispatchEvent(new MouseEvent("mousemove", {
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }));
    }

    window.dispatchEvent(new MouseEvent("mouseup", {
      button: 0,
      buttons: 0,
      clientX: payload.endX,
      clientY: payload.endY,
      bubbles: true,
      cancelable: true,
    }));
  }, { startX, startY, endX, endY });
}

test("@chart terminal V4 keeps all visible timeframes renderable", async ({ page }) => {
  test.setTimeout(420_000);

  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await loginIfRequired(page, "/terminal?v2=1&engine=v4", "terminal V4 timeframe pan zoom");

  const chart = page.locator(".gpu-chart-v4-shell").first();
  const canvas = chart.locator(".gpu-chart-v4-canvas").first();
  await chart.waitFor({ state: "visible", timeout: 45_000 });
  await expect(canvas).toBeAttached({ timeout: 45_000 });

  for (const timeframe of EXPECTED_VISIBLE_TIMEFRAMES) {
    const settled = await settleTimeframe(page, timeframe, chart);
    expect(settled.panMode).toBe("left-drag");

    const metrics = await readCanvasMetrics(canvas);
    expect(metrics.width).toBeGreaterThan(320);
    expect(metrics.height).toBeGreaterThan(220);
  }

  expect(pageErrors).toEqual([]);
});

test("@chart terminal V4 supports toolbar zoom and representative left-drag pan", async ({ page }) => {
  test.setTimeout(180_000);

  await loginIfRequired(page, "/terminal?v2=1&engine=v4", "terminal V4 representative pan zoom");

  const chart = page.locator(".gpu-chart-v4-shell").first();
  const canvas = chart.locator(".gpu-chart-v4-canvas").first();
  await chart.waitFor({ state: "visible", timeout: 45_000 });
  await expect(canvas).toBeAttached({ timeout: 45_000 });

  const timeframe = EXPECTED_VISIBLE_TIMEFRAMES[0];
  const settled = await settleTimeframe(page, timeframe, chart);
  const zoomed = await zoomChartWithToolbar(page, chart, timeframe, settled.visibleBars);
  expect(Math.abs(zoomed.visibleBars - settled.visibleBars)).toBeGreaterThanOrEqual(2);

  const pannable = await expandDatasetForPan(page, chart, timeframe, zoomed.visibleBars);
  expect(pannable.from).toBeGreaterThan(0);

  const box = await chart.boundingBox();
  expect(box).not.toBeNull();
  const centerX = (box?.x || 0) + (box?.width || 0) * 0.55;
  const centerY = (box?.y || 0) + (box?.height || 0) * 0.5;
  await panChartLeftDrag(canvas, centerX, centerY, centerX + 140, centerY);

  const panned = await waitForGpuCameraState(
    chart,
    (state) => state.timeframe === timeframe && (Math.abs(state.from - pannable.from) >= 1 || Math.abs(state.to - pannable.to) >= 1),
  );
  expect(Math.abs(panned.from - pannable.from) + Math.abs(panned.to - pannable.to)).toBeGreaterThan(0.5);
});