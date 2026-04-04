import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

test("terminal replay explainability renders without clearMarks runtime errors", async ({ page }) => {
  test.setTimeout(120_000);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.stack || error));
  });

  await loginIfRequired(page, "/terminal?v2=1", "terminal replay explainability validation");
  await page.waitForLoadState("networkidle");

  const performanceCompat = await page.evaluate(() => {
    const win = window as typeof window & {
      __txtPerformanceCompat?: {
        hadPerformance?: boolean;
        patched?: string[];
        failed?: string[];
      };
    };
    return {
      compat: win.__txtPerformanceCompat || null,
      clearMarksType: typeof window.performance?.clearMarks,
      clearMeasuresType: typeof window.performance?.clearMeasures,
    };
  });

  expect(performanceCompat.clearMarksType).toBe("function");
  expect(performanceCompat.clearMeasuresType).toBe("function");

  await expect(page.getByText("Attribution Replay", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Explainable RL", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  const clearMarksConsoleErrors = consoleErrors.filter((entry) => /clearMarks|mgt\.clearMarks/i.test(entry));
  const clearMarksPageErrors = pageErrors.filter((entry) => /clearMarks|mgt\.clearMarks/i.test(entry));
  expect(clearMarksConsoleErrors).toEqual([]);
  expect(clearMarksPageErrors).toEqual([]);
});