import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000";
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const defaultWebServerCommand = "PLAYWRIGHT_TEST=1 MC_E2E_DEV_DEGRADED=${MC_E2E_DEV_DEGRADED:-1} MC_E2E_DEV_DEGRADED_SILENT=${MC_E2E_DEV_DEGRADED_SILENT:-1} npm run dev";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(chromiumExecutablePath
          ? {
              launchOptions: {
                executablePath: chromiumExecutablePath,
              },
            }
          : {}),
      },
    },
  ],
  webServer: {
    command: process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || defaultWebServerCommand,
    url: `${baseURL}/terminal`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
