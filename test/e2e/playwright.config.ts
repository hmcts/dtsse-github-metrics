import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.TEST_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { outputFolder: "../../playwright-report" }], ["list"]] : "list",
  // The pipeline selects a subset by tag: @smoke on a preview, @regression on AAT, @nightly for the accessibility
  // pass. Left unset, everything runs.
  ...(process.env.E2E_TEST_SCOPE ? { grep: new RegExp(process.env.E2E_TEST_SCOPE) } : {}),
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
    // Chromium needs --no-sandbox in containers, and --disable-software-rasterizer alongside --disable-gpu to
    // stop the renderer hanging where no GPU is available. All four are no-ops on a normal desktop.
    launchOptions: {
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"]
    }
  },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"] } }]
});
