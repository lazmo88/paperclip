#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const mode = process.argv[2] === "watch" ? "watch" : "dev";
const cliArgs = process.argv.slice(3);

const tailscaleAuthFlagNames = new Set([
  "--tailscale-auth",
  "--authenticated-private",
]);

let tailscaleAuth = false;
const forwardedArgs = [];

for (const arg of cliArgs) {
  if (tailscaleAuthFlagNames.has(arg)) {
    tailscaleAuth = true;
    continue;
  }
  forwardedArgs.push(arg);
}

if (process.env.npm_config_tailscale_auth === "true") {
  tailscaleAuth = true;
}
if (process.env.npm_config_authenticated_private === "true") {
  tailscaleAuth = true;
}

const env = {
  ...process.env,
  PAPERCLIP_UI_DEV_MIDDLEWARE: "true",
};

function expandHomePrefix(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolvePaperclipHomeDir() {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) return path.resolve(expandHomePrefix(envHome));
  return path.resolve(os.homedir(), ".paperclip");
}

function resolvePaperclipInstanceId() {
  const raw = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new Error(`Invalid PAPERCLIP_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

function findConfigFileFromAncestors(startDir) {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", "config.json");
    if (fs.existsSync(candidate)) return candidate;
    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }
  return null;
}

function resolvePaperclipConfigPath() {
  if (process.env.PAPERCLIP_CONFIG) return path.resolve(process.env.PAPERCLIP_CONFIG);
  return (
    findConfigFileFromAncestors(process.cwd()) ??
    path.resolve(resolvePaperclipHomeDir(), "instances", resolvePaperclipInstanceId(), "config.json")
  );
}

function resolvePaperclipEnvPath() {
  return path.resolve(path.dirname(resolvePaperclipConfigPath()), ".env");
}

function parseSimpleEnv(contents) {
  const entries = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) continue;
    entries[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1);
  }
  return entries;
}

function ensureAuthenticatedDevSecret() {
  const existing = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (existing) {
    env.PAPERCLIP_AGENT_JWT_SECRET = existing;
    if (!env.BETTER_AUTH_SECRET) env.BETTER_AUTH_SECRET = existing;
    return { secret: existing, source: "environment" };
  }

  const envPath = resolvePaperclipEnvPath();
  if (fs.existsSync(envPath)) {
    const parsed = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
    const fileSecret =
      parsed.PAPERCLIP_AGENT_JWT_SECRET?.trim() || parsed.BETTER_AUTH_SECRET?.trim();
    if (fileSecret) {
      env.PAPERCLIP_AGENT_JWT_SECRET = fileSecret;
      if (!env.BETTER_AUTH_SECRET) env.BETTER_AUTH_SECRET = fileSecret;
      return { secret: fileSecret, source: envPath };
    }
  }

  const secret = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const prefix = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").replace(/\s*$/, "\n") : "";
  fs.writeFileSync(
    envPath,
    `${prefix}PAPERCLIP_AGENT_JWT_SECRET=${secret}\n`,
    { mode: 0o600 },
  );
  env.PAPERCLIP_AGENT_JWT_SECRET = secret;
  env.BETTER_AUTH_SECRET = secret;
  return { secret, source: envPath, created: true };
}

if (tailscaleAuth) {
  env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
  env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
  env.PAPERCLIP_AUTH_BASE_URL_MODE = "auto";
  env.HOST = "0.0.0.0";
  const authSecret = ensureAuthenticatedDevSecret();
  console.log("[paperclip] dev mode: authenticated/private (tailscale-friendly) on 0.0.0.0");
  if (authSecret.created) {
    console.log(`[paperclip] created PAPERCLIP_AGENT_JWT_SECRET in ${authSecret.source}`);
  }
} else {
  console.log("[paperclip] dev mode: local_trusted (default)");
}

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const nodeBin = process.execPath;

function resolveWorkspaceTtsxLoaderPath(packageDir) {
  return path.resolve(process.cwd(), packageDir, "node_modules", "tsx", "dist", "esm", "index.mjs");
}

function spawnNodeWithTsxLoader(args, options = {}) {
  return spawn(nodeBin, args, {
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    shell: false,
  });
}

function formatPendingMigrationSummary(migrations) {
  if (migrations.length === 0) return "none";
  return migrations.length > 3
    ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
    : migrations.join(", ");
}

async function runPnpm(args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(pnpmBin, args, {
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      shell: process.platform === "win32",
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrBuffer += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

async function runNodeWithTsxLoader(packageDir, entryFile, entryArgs = [], options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnNodeWithTsxLoader(
      ["--import", resolveWorkspaceTtsxLoaderPath(packageDir), entryFile, ...entryArgs],
      options,
    );

    let stdoutBuffer = "";
    let stderrBuffer = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdoutBuffer += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderrBuffer += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      resolve({
        code: code ?? 0,
        signal,
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
      });
    });
  });
}

async function maybePreflightMigrations() {
  if (mode !== "watch") return;
  if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return;

  const status = await runNodeWithTsxLoader(
    "packages/db",
    path.resolve(process.cwd(), "packages/db/src/migration-status.ts"),
    ["--json"],
    { env },
  );
  if (status.code !== 0) {
    process.stderr.write(status.stderr || status.stdout);
    process.exit(status.code);
  }

  let payload;
  try {
    payload = JSON.parse(status.stdout.trim());
  } catch (error) {
    process.stderr.write(status.stderr || status.stdout);
    throw error;
  }

  if (payload.status !== "needsMigrations" || payload.pendingMigrations.length === 0) {
    return;
  }

  const autoApply = process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true";
  let shouldApply = autoApply;

  if (!autoApply) {
    if (!stdin.isTTY || !stdout.isTTY) {
      shouldApply = true;
    } else {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        const answer = (
          await prompt.question(
            `Apply pending migrations (${formatPendingMigrationSummary(payload.pendingMigrations)}) now? (y/N): `,
          )
        )
          .trim()
          .toLowerCase();
        shouldApply = answer === "y" || answer === "yes";
      } finally {
        prompt.close();
      }
    }
  }

  if (!shouldApply) return;

  const migrate = spawn(pnpmBin, ["db:migrate"], {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  const exit = await new Promise((resolve) => {
    migrate.on("exit", (code, signal) => resolve({ code: code ?? 0, signal }));
  });
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  if (exit.code !== 0) {
    process.exit(exit.code);
  }
}

await maybePreflightMigrations();

if (mode === "watch") {
  env.PAPERCLIP_MIGRATION_PROMPT = "never";
}

const serverEntryFile = path.resolve(process.cwd(), "server/src/index.ts");
const child = spawnNodeWithTsxLoader(
  [
    ...(mode === "watch" ? ["--watch"] : []),
    "--import",
    resolveWorkspaceTtsxLoaderPath("server"),
    serverEntryFile,
    ...forwardedArgs,
  ],
  { stdio: "inherit", env },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
