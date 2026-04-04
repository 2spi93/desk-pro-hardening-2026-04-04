import { expect, test } from "@playwright/test";

import { loginIfRequired } from "./helpers/terminal";

const REQUIRED_BLOCKS = [
  "Routing Governance",
  "Infrastructure Posture",
  "Execution Studio",
  "Latest Decision",
  "Local Inference Desk",
  "Regime Lab",
  "Scenario Lab",
  "Memory & Calibration",
  "Execution Journal",
] as const;

test("ai desk renders the institutional blocks for an authenticated operator", async ({ page }) => {
  test.setTimeout(120_000);

  await loginIfRequired(page, "/ai", "ai desk validation");

  await expect(page.getByRole("heading", { name: "Institutional AI Desk" })).toBeVisible({ timeout: 30_000 });
  for (const block of REQUIRED_BLOCKS) {
    await expect(page.getByText(block).first()).toBeVisible({ timeout: 30_000 });
  }
});