import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

test("workspace change -> reset risk alert -> persist -> reload", async ({ page }) => {
  await loginIfRequired(page, "/terminal", "risk workspace test");

  const riskControls = page.locator(".risk-timeline-controls").first();
  const thresholdInput = riskControls.locator('label:has-text("Threshold") input[type="number"]').first();
  const hardPctInput = riskControls.locator('label:has-text("Hard %") input[type="number"]').first();
  const hardAlertSelect = riskControls.locator('label:has-text("Hard alert") select').first();
  const resetButton = riskControls.getByRole("button", { name: /reset/i }).first();
  const swingPreset = page.getByRole("button", { name: /Swing/i }).first();

  await swingPreset.click();
  await expect(page.locator("text=preset actif: Swing 3/10").first()).toBeVisible();

  const baselineThreshold = await thresholdInput.inputValue();
  const baselineHardPct = await hardPctInput.inputValue();
  const baselineHardAlert = await hardAlertSelect.inputValue();

  await thresholdInput.fill("7");
  await hardAlertSelect.selectOption("on");
  await hardPctInput.fill("72");

  await resetButton.click();
  await expect(thresholdInput).toHaveValue(baselineThreshold);
  await expect(hardPctInput).toHaveValue(baselineHardPct);
  await expect(hardAlertSelect).toHaveValue(baselineHardAlert);

  await page.reload({ waitUntil: "domcontentloaded" });

  const thresholdAfterReload = page.locator('label:has-text("Threshold") input[type="number"]').first();
  const hardPctAfterReload = page.locator('label:has-text("Hard %") input[type="number"]').first();
  const hardAlertAfterReload = page.locator('label:has-text("Hard alert") select').first();
  await expect(page.locator("text=preset actif: Swing 3/10").first()).toBeVisible();
  await expect(thresholdAfterReload).toHaveValue(baselineThreshold);
  await expect(hardPctAfterReload).toHaveValue(baselineHardPct);
  await expect(hardAlertAfterReload).toHaveValue(baselineHardAlert);
});
