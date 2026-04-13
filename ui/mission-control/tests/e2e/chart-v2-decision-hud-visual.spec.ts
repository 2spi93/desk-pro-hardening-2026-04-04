import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

test("@chart terminal V2 state-first HUD visual remains locked", async ({ page }) => {
  test.setTimeout(180_000);

  await loginIfRequired(page, "/terminal?v2=1&engine=v4&perfDebug=1", "terminal V2 decision HUD visual");

  const v2Toggle = page.getByRole("button", { name: /^V2 Surface /i }).first();
  await expect(v2Toggle).toBeVisible({ timeout: 45_000 });
  if ((await v2Toggle.textContent())?.includes("OFF")) {
    await v2Toggle.click();
  }

  await expect(page.locator(".terminal-v2-shell").first()).toBeVisible({ timeout: 45_000 });

  const decisionCard = page.getByTestId("terminal-v2-decision-state");
  await expect(decisionCard).toBeVisible({ timeout: 45_000 });
  await expect(decisionCard.locator(".terminal-v2-card-kicker")).toContainText("Decision Engine V2");
  await expect.poll(async () => decisionCard.locator("[data-smart-decision-state]").getAttribute("data-smart-decision-state"), {
    timeout: 30_000,
  }).not.toBeNull();

  await page.addStyleTag({
    content: [
      ".terminal-v2-card-decision,",
      ".terminal-v2-decision-state,",
      ".terminal-v2-decision-headline,",
      ".terminal-v2-decision-copy,",
      ".terminal-v2-decision-metrics,",
      ".perception-levels { animation: none !important; transition: none !important; }",
    ].join("\n"),
  });

  const screenshot = await decisionCard.screenshot({
    animations: "disabled",
    caret: "hide",
  });
  expect(screenshot).toMatchSnapshot("terminal-v2-decision-state.png", {
    maxDiffPixels: 150,
  });
});