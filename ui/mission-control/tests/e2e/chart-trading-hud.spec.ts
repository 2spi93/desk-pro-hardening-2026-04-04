import { expect, test } from "@playwright/test";
import { loginIfRequired } from "./helpers/terminal";

test("@chart chart trading HUD keeps key interactions stable after extraction", async ({ page }) => {
  test.setTimeout(120_000);

  await loginIfRequired(page, "/terminal", "HUD test");

  const candleProbe = page.locator(".chart-flow-pill").filter({
    hasText: /CANDLE t\d+ u\d+ hb\d+ age/i,
  }).first();
  await expect(candleProbe).toBeVisible({ timeout: 30_000 });

  const hud = page.locator(".chart-order-hud").first();
  await hud.waitFor({ state: "visible", timeout: 30_000 });
  const compactHud = await hud.evaluate((element) => element.classList.contains("is-compact-mode") || element.classList.contains("is-detached"));

  const body = hud.locator(".chart-order-hud-body");
  if (!compactHud && await body.count() === 0) {
    const fullViewButton = page.getByRole("button", { name: /^View:F$/i }).first();
    if (await fullViewButton.count() > 0) {
      await fullViewButton.click({ force: true });
    }
    const expandButton = hud.getByRole("button", { name: /^Expand$/i }).first();
    if (await expandButton.count() > 0) {
      await expandButton.click({ force: true });
    }
  }
  await expect(page.locator(".chart-flow-pill").filter({ hasText: /V8\.5\.1/i }).first()).toBeVisible();
  await expect(page.locator(".chart-flow-pill").filter({ hasText: /V8\.6 STAB/i }).first()).toBeVisible();
  await expect(page.locator(".chart-flow-pill").filter({ hasText: /^V9 /i }).first()).toBeVisible();

  if (compactHud) {
    await expect(page.getByText(/ORDER PREVIEW/i).first()).toBeVisible();
    return;
  }

  await expect(body).toBeVisible();
  await expect(hud.locator(".chart-decision-secondary")).toBeVisible();

  const tuneButton = hud.locator(".chart-decision-tools .chart-chip").first();
  await expect(tuneButton).toBeVisible();
  await expect(tuneButton).toContainText("Tune");
  await tuneButton.click();
  await expect(hud.locator(".chart-confluence-controls")).toBeVisible();
  await expect(tuneButton).toContainText("Hide Tune");

  await hud.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  const schedulerBlock = hud.getByText("V8.5.1 Broker Scheduler").first();
  await schedulerBlock.scrollIntoViewIfNeeded();
  await expect(schedulerBlock).toBeVisible();
  await expect(hud.getByText("Stability Engine").first()).toBeVisible();
  await expect(hud.getByText("V9 Strategy Evolution").first()).toBeVisible();

  const snapButton = hud.getByRole("button", { name: /^Snap On$/i }).first();
  await expect(snapButton).toBeVisible();
  await snapButton.click();
  await expect(hud.getByRole("button", { name: /^Snap Off$/i }).first()).toBeVisible();

  const armSendButton = hud.getByRole("button", { name: /^Arm Send$/i }).first();
  await expect(armSendButton).toBeVisible();
  await armSendButton.click();
  await expect(hud.getByRole("button", { name: /^Armed$/i }).first()).toBeVisible();

  if (!compactHud) {
    await hud.getByRole("button", { name: /^Reduce$/i }).first().click({ force: true });
    const collapsedBody = hud.locator(".chart-order-hud-body");
    if (await collapsedBody.count() > 0) {
      await expect(collapsedBody).not.toBeVisible();
    }
    const finalExpandButton = hud.getByRole("button", { name: /^Expand$/i }).first();
    await expect(finalExpandButton).toBeVisible();
    await finalExpandButton.click({ force: true });
    await expect(body).toBeVisible();
    await expect(hud.locator(".chart-decision-secondary")).toBeVisible();
    await expect(hud.locator(".chart-confluence-controls")).toBeVisible();
  }

  await hud.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(hud.getByRole("button", { name: /^Armed$/i }).first()).toBeVisible();
  await expect(hud.getByRole("button", { name: /^Snap Off$/i }).first()).toBeVisible();
});