import type { Locator, Page } from "@playwright/test";

async function waitForNextPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
}

async function captureChartScreenshot(page: Page, chart: Locator): Promise<Buffer> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await chart.waitFor({ state: "visible", timeout: 5_000 });
      await chart.locator("canvas").first().waitFor({ state: "attached", timeout: 5_000 });
      await chart.scrollIntoViewIfNeeded();
      await waitForNextPaint(page);
      const box = await chart.boundingBox();
      if (!box || box.width < 8 || box.height < 8) {
        throw new Error("Chart bounding box is not ready for screenshot capture");
      }
      return await page.screenshot({
        clip: {
          x: Math.max(0, box.x),
          y: Math.max(0, box.y),
          width: Math.max(1, box.width),
          height: Math.max(1, box.height),
        },
      });
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(Math.min(250 + attempt * 100, 800));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to capture chart screenshot");
}

export async function analyzeChartScreenshot(page: Page, chart: Locator): Promise<{
  width: number;
  height: number;
  nonBackgroundPixels: number;
  accentPixels: number;
  bullishPixels: number;
  bearishPixels: number;
  colorBuckets: number;
}> {
  const screenshot = await captureChartScreenshot(page, chart);

  return page.evaluate(async (encoded) => {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Unable to decode chart screenshot"));
    });
    image.src = `data:image/png;base64,${encoded}`;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      return {
        width: image.width,
        height: image.height,
        nonBackgroundPixels: 0,
        accentPixels: 0,
        bullishPixels: 0,
        bearishPixels: 0,
        colorBuckets: 0,
      };
    }

    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBackgroundPixels = 0;
    let accentPixels = 0;
    let bullishPixels = 0;
    let bearishPixels = 0;
    const buckets = new Set<string>();

    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const alpha = pixels[index + 3];
      if (alpha < 150) {
        continue;
      }

      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      if (luminance > 26 || max - min > 20) {
        nonBackgroundPixels += 1;
      }
      if (max > 60 && max - min > 28) {
        accentPixels += 1;
        buckets.add(`${Math.floor(red / 32)}-${Math.floor(green / 32)}-${Math.floor(blue / 32)}`);
      }
      if (green > 110 && red < 150 && blue < 170) {
        bullishPixels += 1;
      }
      if (red > 140 && green < 130 && blue < 150) {
        bearishPixels += 1;
      }
    }

    return {
      width: canvas.width,
      height: canvas.height,
      nonBackgroundPixels,
      accentPixels,
      bullishPixels,
      bearishPixels,
      colorBuckets: buckets.size,
    };
  }, screenshot.toString("base64"));
}