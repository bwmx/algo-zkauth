import { defineConfig } from "@playwright/test";

// Runs against the compose local stack; start it first with
//   docker compose --profile local up --build
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 240_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_DEMO_URL ?? "http://localhost:8765",
    acceptDownloads: true,
    // Pin localhost to IPv4 so the browser reaches the stack's loopback ports even
    // when another process holds the same port on ::1. The page origin stays localhost.
    launchOptions: { args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
