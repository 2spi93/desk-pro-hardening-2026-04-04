import { existsSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

export const EXPECTED_VISIBLE_TIMEFRAMES = ["1s", "5s", "10s", "30s", "1m", "5m", "15m", "30m", "1h", "4h", "8h", "1d", "1w", "1M"];

const DEFAULT_OPERATOR_PASSWORD_PATHS = [
  "/workspace/secrets/default_operator_password",
  "/opt/txt/secrets/default_operator_password",
];

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isE2eDevDegradedModeEnabled(): boolean {
  return isTruthy(process.env.MC_E2E_DEV_DEGRADED);
}

function resolveControlPlaneFallback(): string {
  return String(
    process.env.PLAYWRIGHT_CONTROL_PLANE_URL
    || process.env.CONTROL_PLANE_URL
    || process.env.CONTROL_PLANE_FALLBACK_URL
    || "https://api.txt.gtixt.com",
  ).trim();
}

function resolveValidatedUrl(name: string, fallback = ""): URL {
  const raw = String(process.env[name] || fallback).trim();
  if (!raw) {
    throw new Error(`${name} must be set to an https:// URL before running secure Playwright smoke flows`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const isLoopback = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  const allowInsecureControlPlane = name === "PLAYWRIGHT_CONTROL_PLANE_URL" && isTruthy(process.env.PLAYWRIGHT_ALLOW_INSECURE_CONTROL_PLANE);
  if (parsed.protocol !== "https:" && !(isLoopback && isTruthy(process.env.PLAYWRIGHT_ALLOW_INSECURE_LOCALHOST)) && !allowInsecureControlPlane) {
    throw new Error(`${name} must use https:// unless PLAYWRIGHT_ALLOW_INSECURE_LOCALHOST=1 is explicitly set for loopback-only debugging`);
  }
  return parsed;
}

function resolveOperatorPassword(): string {
  const password = process.env.PLAYWRIGHT_OPERATOR_PASSWORD || process.env.MC_SMOKE_PASSWORD;
  if (password) {
    return password;
  }

  for (const path of DEFAULT_OPERATOR_PASSWORD_PATHS) {
    if (existsSync(path)) {
      const filePassword = readFileSync(path, "utf8").trim();
      if (filePassword) {
        return filePassword;
      }
    }
  }

  return "";
}

async function injectLocalOperatorSession(page: Page): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const baseUrl = new URL(page.url());
  const payload = Buffer.from(JSON.stringify({ role: "operator", exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString("base64url");
  const token = `${payload}.signature`;

  await page.context().addCookies([
    {
      name: "mc_token",
      value: token,
      url: baseUrl.toString(),
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.protocol === "https:",
    },
    {
      name: "mc_token_compat",
      value: token,
      url: baseUrl.toString(),
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.protocol === "https:",
    },
  ]);
}

async function tryUiOperatorLogin(page: Page, password: string, terminalPath: string): Promise<boolean> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  const username = page.locator("#username");
  if (await username.count() === 0) {
    return false;
  }
  await username.fill("operator");
  await page.locator("#password").fill(password);
  await page.locator('form[action="/api/auth/login"] button[type="submit"]').click();
  await page.waitForLoadState("domcontentloaded");

  if (page.url().includes("/change-password")) {
    throw new Error(`Operator account requires password change before ${terminalPath} can run`);
  }

  await page.goto(terminalPath, { waitUntil: "domcontentloaded" });
  return true;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function seedOperatorSession(page: Page): Promise<void> {
  const password = resolveOperatorPassword();
  if (!password) {
    await injectLocalOperatorSession(page);
    return;
  }

  const controlPlaneUrl = resolveValidatedUrl("PLAYWRIGHT_CONTROL_PLANE_URL", resolveControlPlaneFallback());
  const baseUrl = resolveValidatedUrl("PLAYWRIGHT_BASE_URL", "https://app.txt.gtixt.com");
  let response;
  try {
    response = await page.request.post(`${controlPlaneUrl.toString().replace(/\/$/, "")}/v1/auth/login`, {
      data: { username: "operator", password },
    });
  } catch {
    if (isE2eDevDegradedModeEnabled()) {
      await injectLocalOperatorSession(page);
    }
    return;
  }
  if (!response.ok()) {
    if (isE2eDevDegradedModeEnabled()) {
      await injectLocalOperatorSession(page);
    }
    return;
  }

  let payload: { access_token?: string } | null = null;
  try {
    payload = await response.json() as { access_token?: string };
  } catch {
    return;
  }
  if (!payload.access_token) {
    return;
  }

  await page.context().addCookies([
    {
      name: "mc_token",
      value: payload.access_token,
      url: baseUrl.toString(),
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.protocol === "https:",
    },
    {
      name: "mc_token_compat",
      value: payload.access_token,
      url: baseUrl.toString(),
      httpOnly: true,
      sameSite: "Lax",
      secure: baseUrl.protocol === "https:",
    },
  ]);
}

export async function loginIfRequired(page: Page, terminalPath = "/terminal", failureContext = "terminal test"): Promise<void> {
  const password = resolveOperatorPassword();
  await seedOperatorSession(page);
  await page.goto(terminalPath, { waitUntil: "domcontentloaded" });

  const username = page.locator("#username");
  if (await username.count() === 0) {
    return;
  }

  if (isE2eDevDegradedModeEnabled()) {
    await injectLocalOperatorSession(page);
    await page.goto(terminalPath, { waitUntil: "domcontentloaded" });
    if (await page.locator("#username").count() === 0) {
      return;
    }
  }

  if (!password) {
    throw new Error(`PLAYWRIGHT_OPERATOR_PASSWORD is required when ${terminalPath} redirects to login`);
  }
  const loggedIn = await tryUiOperatorLogin(page, password, terminalPath);
  if (!loggedIn) {
    throw new Error(`Unable to establish operator session for ${failureContext}`);
  }
}