import { expect, test } from "@playwright/test";
import { loginIfRequired } from "./helpers/terminal";

const TF_SEQUENCE = ["1s", "30s", "1h", "1M"] as const;

test("@chart terminal timeframe selection keeps the active state aligned across visible TF buttons", async ({ page }) => {
  await loginIfRequired(page, "/terminal", "timeframe selection test");

  for (const timeframe of TF_SEQUENCE) {
    const button = page.getByRole("button", { name: new RegExp(`^${timeframe}$`) }).first();
    await expect(button).toBeVisible({ timeout: 45_000 });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true", { timeout: 15_000 });
  }
});