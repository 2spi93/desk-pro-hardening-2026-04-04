import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

test("terminal UI click flow executes a full cancel/replace path", async ({ page }) => {
  test.setTimeout(120_000);

  await loginIfRequired(page, "/terminal?e2eScheduler=cancel-replace", "terminal cancel/replace UI");

  const execTicket = page.locator(".exec-ticket-block").first();
  await expect(execTicket).toBeVisible({ timeout: 60_000 });

  await execTicket.locator('input[placeholder="account_id"]').fill("acc-e2e-cancel-replace");
  await execTicket.locator('input[placeholder="symbol"]').fill("BTCUSDT");
  await execTicket.locator('input[placeholder="notional USD"]').fill("50");
  await execTicket.locator('input[placeholder="rationale"]').fill("playwright ui cancel/replace");

  const schedulerPill = page.locator(".chart-flow-pill").filter({ hasText: /V8\.5\.1/i }).first();
  await expect.poll(async () => (await schedulerPill.textContent()) || "", { timeout: 30_000 }).toContain("CANCEL_REPLACE");

  await execTicket.getByRole("button", { name: /Send Order/i }).click();

  const resultSummary = execTicket.locator("summary").filter({ hasText: /Résultat/i }).first();
  await expect(resultSummary).toBeVisible({ timeout: 30_000 });
  await resultSummary.click();

  const resultPre = execTicket.locator("pre").first();
  await expect.poll(async () => (await resultPre.textContent()) || "", { timeout: 30_000 }).toContain("\"cancel_replace\"");
  const resultPayload = JSON.parse((await resultPre.textContent()) || "{}");

  expect(resultPayload.broker_aware_scheduler?.action).toBe("CANCEL_REPLACE");
  expect(resultPayload.broker_aware_scheduler?.supports_cancel_replace).toBe(true);
  expect(resultPayload.broker_aware_scheduler?.supports_modify).toBe(false);
  expect(resultPayload.broker_aware_scheduler?.replace_strategy).toBe("cancel_replace");
  expect(Array.isArray(resultPayload.child_orders)).toBeTruthy();
  expect(resultPayload.child_orders).toHaveLength(2);
  expect(resultPayload.child_orders[0]?.cancel_replace?.status).toBe("cancelled");
  expect(resultPayload.child_orders[0]?.cancel_replace?.strategy).toBe("cancel_replace");

  const mockControlPlaneUrl = process.env.CONTROL_PLANE_URL || process.env.PLAYWRIGHT_CONTROL_PLANE_URL;
  expect(mockControlPlaneUrl).toBeTruthy();
  const recordedResponse = await page.request.get(`${mockControlPlaneUrl}/__mock/requests`);
  expect(recordedResponse.ok()).toBeTruthy();
  const recorded = await recordedResponse.json();
  const orderFlow = Array.isArray(recorded.requests)
    ? recorded.requests.filter((entry: { path?: string }) => entry.path === "/v1/mt5/orders/filter" || entry.path === "/v1/live/orders/cancel")
    : [];

  expect(orderFlow.length).toBeGreaterThanOrEqual(3);
  expect(orderFlow[0].path).toBe("/v1/mt5/orders/filter");
  expect(orderFlow[1].path).toBe("/v1/live/orders/cancel");
  expect(orderFlow[2].path).toBe("/v1/mt5/orders/filter");
  expect(orderFlow[1].body.order_id).toBe("mock-order-1");
});