import { expect, test, type Locator, type Page } from "@playwright/test";

async function seedVisualSession(page: Page): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const origin = new URL(page.url()).origin;
  const payload = Buffer.from(JSON.stringify({ role: "operator", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  await page.context().addCookies([
    {
      name: "mc_token",
      value: `${payload}.signature`,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
    {
      name: "mc_token_compat",
      value: `${payload}.signature`,
      url: origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: origin.startsWith("https://"),
    },
  ]);
}

async function captureVisualLock(page: Page, step: "decision" | "operator" | "pnl", target: Locator): Promise<Buffer> {
  await page.goto(`/terminal/guide-visual-lock?step=${step}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#username")).toHaveCount(0, { timeout: 30_000 });

  const stage = page.getByTestId("guide-visual-lock-stage");
  const overlay = page.getByRole("dialog", { name: "Coach overlay terminal" });
  await expect(stage).toBeVisible({ timeout: 30_000 });
  await expect(overlay).toBeVisible({ timeout: 30_000 });
  await expect(target).toBeVisible({ timeout: 30_000 });
  await expect(target).toHaveClass(/is-guided-target/, { timeout: 30_000 });

  return stage.screenshot({
    animations: "disabled",
    caret: "hide",
  });
}

test("@terminal coach overlay and guided halos remain visually locked on the three guided zones", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1800 });

  await seedVisualSession(page);
  const decisionShot = await captureVisualLock(page, "decision", page.locator("#terminal-decision-layer"));
  expect(decisionShot).toMatchSnapshot("terminal-coach-overlay-decision.png", {
    maxDiffPixels: 220,
  });

  const operatorShot = await captureVisualLock(page, "operator", page.locator("#terminal-operator-action"));
  expect(operatorShot).toMatchSnapshot("terminal-coach-overlay-operator.png", {
    maxDiffPixels: 220,
  });

  const pnlTruthShot = await captureVisualLock(page, "pnl", page.locator("#terminal-pnl-truth"));
  expect(pnlTruthShot).toMatchSnapshot("terminal-coach-overlay-pnl-truth.png", {
    maxDiffPixels: 220,
  });
});
