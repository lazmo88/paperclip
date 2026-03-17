import path from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(process.cwd(), ".paperclip-e2e", String(PORT));

function sh(value: string): string {
  return JSON.stringify(value);
}

const webServerCommand = [
  "env -i",
  `HOME=${sh(process.env.HOME ?? "")}`,
  `PATH=${sh(process.env.PATH ?? "")}`,
  `SHELL=${sh(process.env.SHELL ?? "/bin/sh")}`,
  `TERM=${sh(process.env.TERM ?? "xterm")}`,
  `LANG=${sh(process.env.LANG ?? "C.UTF-8")}`,
  `PORT=${PORT}`,
  "PAPERCLIP_DEPLOYMENT_MODE=local_trusted",
  "pnpm paperclipai onboard --yes --run",
  `-d ${sh(DATA_DIR)}`,
].join(" ");

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // The webServer directive starts an isolated local_trusted Paperclip instance.
  webServer: {
    command: webServerCommand,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !!process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
