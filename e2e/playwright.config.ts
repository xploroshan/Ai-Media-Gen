import { defineConfig, devices } from "@playwright/test";

/**
 * E2E suite — always runs against StubProvider (no FAL_KEY), dev-auth mode
 * (no RESEND_API_KEY): zero external calls (SPEC §3).
 */
export default defineConfig({
  testDir: ".",
  testMatch: "tests/**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // media pipeline tests share worker capacity; keep deterministic
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Use a pre-installed Chromium when provided (e.g. sandboxed/CI images
        // that ship /opt/pw-browsers); default download otherwise.
        launchOptions: process.env.PW_CHROMIUM_PATH
          ? { executablePath: process.env.PW_CHROMIUM_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: "pnpm --filter web dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: "..",
    env: {
      RESEND_API_KEY: "",
      FAL_KEY: "",
    },
  },
});
