import { expect, test } from "@playwright/test";
import { EXPECTED_VISIBLE_TIMEFRAMES, escapeRegExp, loginIfRequired } from "./helpers/terminal";

test("@chart terminal timeframe selector exposes the full visible production grid", async ({ page }) => {
  await loginIfRequired(page, "/terminal", "timeframe grid test");

  for (const timeframe of EXPECTED_VISIBLE_TIMEFRAMES) {
    await expect(page.getByRole("button", { name: new RegExp(`^${escapeRegExp(timeframe)}$`) }).first()).toBeVisible({ timeout: 45_000 });
  }
});