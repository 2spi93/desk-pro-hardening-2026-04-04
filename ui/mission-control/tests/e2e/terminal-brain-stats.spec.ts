import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

test("terminal renders brain stats line for an authenticated operator session", async ({ page }) => {
  test.setTimeout(120_000);

  await loginIfRequired(page, "/terminal?v2=1", "brain stats validation");

  const brainStats = page.getByTestId("terminal-brain-stats").first();
  await expect(brainStats).toBeVisible({ timeout: 30_000 });
  await expect(brainStats).toHaveText(/Brain stats: replay \d+ · learns \d+ · win \d+\.\d%/, { timeout: 30_000 });
});