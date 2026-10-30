import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:5173", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.PLAYWRIGHT_CHROMIUM ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM } } : {}) } },
    { name: "mobile-webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "npm run dev --workspace=@videocraft/web -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
