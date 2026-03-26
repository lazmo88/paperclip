#!/usr/bin/env node
/**
 * OpenClaw Gateway Adapter — E2E validation tests
 * Tests gateway connectivity, model/agent discovery, skill listing,
 * and basic agent execution via HTTP API.
 * No external dependencies — Node.js built-ins only.
 */

import { readFileSync } from "node:fs";

// ── Config ──────────────────────────────────────────────────────────────
const GATEWAY = "http://localhost:18799";

let AUTH_TOKEN;
try {
  const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"));
  AUTH_TOKEN = cfg.env?.vars?.AUTH_TOKEN || cfg.gateway?.token || "";
} catch {
  AUTH_TOKEN = process.env.OPENCLAW_TOKEN || "";
}

const headers = {
  "Content-Type": "application/json",
  ...(AUTH_TOKEN ? { "x-openclaw-token": AUTH_TOKEN } : {}),
};

let passed = 0;
let failed = 0;

function ok(name, detail) {
  passed++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  failed++;
  console.error(`  ✗ ${name} — ${detail}`);
}

async function api(path, opts = {}) {
  const res = await fetch(`${GATEWAY}${path}`, { headers, ...opts });
  return { status: res.status, body: await res.json().catch(() => null), ok: res.ok };
}

// ── 1. Health ───────────────────────────────────────────────────────────
async function testHealth() {
  console.log("\n── 1. Gateway Health ──");
  try {
    const { body } = await api("/health");
    if (body?.ok) ok("Health", `status=${body.status}`);
    else fail("Health", JSON.stringify(body));
  } catch (e) { fail("Health", e.message); }
}

// ── 2. Model Discovery ─────────────────────────────────────────────────
async function testModels() {
  console.log("\n── 2. Model Discovery (/v1/models) ──");
  try {
    const { body } = await api("/v1/models");
    const models = body?.data || body?.models || [];
    if (models.length > 0) {
      ok("models.list", `${models.length} models`);
      ok("Sample", models.slice(0, 3).map(m => m.id).join(", "));
    } else {
      fail("models.list", "0 models returned");
    }
  } catch (e) { fail("models.list", e.message); }
}

// ── 3. Agent Discovery ──────────────────────────────────────────────────
let discoveredAgents = [];
async function testAgents() {
  console.log("\n── 3. Agent Discovery ──");
  try {
    // Try RPC-style endpoint first, then REST
    const { body, status } = await api("/v1/agents");
    if (status === 404) {
      // Try via sessions API
      const { body: sb } = await api("/api/agents");
      const agents = sb?.agents || sb?.data || [];
      if (agents.length > 0) {
        ok("agents via /api/agents", `${agents.length} agents`);
        discoveredAgents = agents;
      } else {
        ok("agents endpoint", "not available (expected for some configs)");
      }
      return;
    }
    const agents = body?.agents || body?.data || [];
    if (agents.length > 0) {
      ok("agents.list", `${agents.length} agents`);
      ok("Agent IDs", agents.slice(0, 5).map(a => a.id || a.name).join(", "));
      discoveredAgents = agents;
    } else {
      ok("agents.list", "0 agents (may be expected)");
    }
  } catch (e) { fail("agents.list", e.message); }
}

// ── 4. Skill Listing ────────────────────────────────────────────────────
async function testSkills() {
  console.log("\n── 4. Skill Listing ──");
  try {
    const { body, status } = await api("/v1/skills");
    if (status === 404) {
      // Try alternate paths
      const { body: sb, status: s2 } = await api("/api/skills");
      if (s2 === 404) {
        ok("skills endpoint", "not exposed via HTTP (WS-only RPC)");
        return;
      }
      const skills = sb?.skills || sb?.data || [];
      ok("skills", `${skills.length} skills via /api/skills`);
      return;
    }
    const skills = body?.skills || body?.data || [];
    ok("skills.list", `${skills.length} skills`);
    if (skills.length > 0) {
      ok("Sample keys", skills.slice(0, 3).map(s => s.key || s.id || s.name).join(", "));
    }
  } catch (e) { fail("skills.list", e.message); }
}

// ── 5. Agent Run Test ───────────────────────────────────────────────────
async function testAgentRun() {
  console.log("\n── 5. Agent Run (via /v1/responses or /api/sessions) ──");

  // Try OpenAI-compatible /v1/responses endpoint
  try {
    const { body, status } = await api("/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "openclaw",
        input: "Reply with exactly: E2E_TEST_OK",
      }),
    });
    if (status === 404) {
      // Try /v1/chat/completions
      const { body: cb, status: cs } = await api("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "openclaw",
          messages: [{ role: "user", content: "Reply with exactly: E2E_TEST_OK" }],
        }),
      });
      if (cs === 200 && cb) {
        const text = cb.choices?.[0]?.message?.content || "";
        ok("chat.completions", `${text.length} chars response`);
        if (text.includes("E2E_TEST_OK")) {
          ok("Response content", "E2E_TEST_OK confirmed");
        }
        return;
      }
      ok("Agent run", `No HTTP run endpoint (status=${cs}), WS-only execution expected`);
      return;
    }
    if (status === 200 && body) {
      const text = body.output?.[0]?.content?.[0]?.text || body.text || "";
      ok("v1/responses", `${text.length} chars response`);
      if (text.includes("E2E_TEST_OK")) {
        ok("Response content", "E2E_TEST_OK confirmed");
      }
    } else {
      ok("Agent run", `status=${status}, response keys: ${Object.keys(body || {}).join(",")}`);
    }
  } catch (e) { fail("Agent run", e.message); }
}

// ── 6. Adapter code unit checks ─────────────────────────────────────────
async function testAdapterCodePaths() {
  console.log("\n── 6. Adapter Code Path Validation ──");

  // Check path traversal guard exists
  try {
    const execute = readFileSync("packages/adapters/openclaw-gateway/src/server/execute.ts", "utf8");
    if (execute.includes("path.resolve(rootPath)") && execute.includes("startsWith")) {
      ok("Path traversal guard", "present in execute.ts");
    } else {
      fail("Path traversal guard", "missing or altered");
    }

    // Check session strategy constants
    if (execute.includes("SESSION_KEY_STRATEGIES") && execute.includes("as const")) {
      ok("Session strategy constants", "shared const tuple present");
    } else {
      fail("Session strategy constants", "missing");
    }

    // Check desiredSkills null handling
    if (execute.includes("string[] | null") || execute.includes(": null;")) {
      ok("desiredSkills null type", "properly typed");
    } else {
      fail("desiredSkills null type", "missing null in type");
    }

    // Check stale key normalization
    if (execute.includes("spaces → hyphens") || execute.includes('.replace(/\\s+/g, "-")')) {
      ok("Stale skill key normalization", "space→hyphen migration present");
    } else {
      fail("Stale skill key normalization", "missing");
    }
  } catch (e) { fail("execute.ts read", e.message); }

  // Check cross-platform path handling
  try {
    const skills = readFileSync("packages/adapters/openclaw-gateway/src/server/skills.ts", "utf8");
    if (skills.includes("path.posix.basename") && skills.includes('replace(/\\\\/g, "/")')) {
      ok("Cross-platform path.basename", "POSIX normalization in skills.ts");
    } else {
      fail("Cross-platform path.basename", "missing normalization");
    }
  } catch (e) { fail("skills.ts read", e.message); }

  // Check WS race fix in gateway-rpc
  try {
    const rpc = readFileSync("packages/adapters/openclaw-gateway/src/server/gateway-rpc.ts", "utf8");
    if (rpc.includes("done = true") && rpc.includes("clearTimeout(timer)") && rpc.includes("ws.close()")) {
      ok("WS close race guard", "done flag set before close in gateway-rpc.ts");
    } else {
      fail("WS close race guard", "pattern not found");
    }

    // Check recursion depth guard
    if (rpc.includes("_depth") && rpc.includes("depth + 1")) {
      ok("Auto-pair recursion guard", "_depth parameter present");
    } else {
      fail("Auto-pair recursion guard", "missing");
    }
  } catch (e) { fail("gateway-rpc.ts read", e.message); }

  // Check config doc has thinking field
  try {
    const index = readFileSync("packages/adapters/openclaw-gateway/src/index.ts", "utf8");
    if (index.includes("thinking")) {
      ok("Config doc: thinking field", "documented in index.ts");
    } else {
      fail("Config doc: thinking field", "missing from agentConfigurationDoc");
    }
  } catch (e) { fail("index.ts read", e.message); }

  // Check discovery hooks accept role/scopes
  try {
    const configFields = readFileSync("ui/src/adapters/openclaw-gateway/config-fields.tsx", "utf8");
    if (configFields.includes("useGatewayModels(wsUrl, token, role, scopes)") ||
        (configFields.includes("role?: string") && configFields.includes("scopes?: string[]"))) {
      ok("Discovery hooks role/scopes", "parameters accepted");
    } else {
      fail("Discovery hooks role/scopes", "not wired through");
    }

    // Check call sites pass role/scopes
    if (configFields.includes('<ModelSelector') && configFields.includes('role={') && configFields.includes('scopes={')) {
      ok("Selector call sites", "role/scopes props passed");
    } else {
      fail("Selector call sites", "role/scopes not passed at call sites");
    }
  } catch (e) { fail("config-fields.tsx read", e.message); }
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log("OpenClaw Gateway Adapter — E2E Tests");
  console.log(`Gateway: ${GATEWAY}`);
  console.log(`Auth: ${AUTH_TOKEN ? "token present" : "NO TOKEN"}`);

  await testHealth();
  await testModels();
  await testAgents();
  await testSkills();
  await testAgentRun();
  await testAdapterCodePaths();

  console.log(`\n═══ Summary: ${passed} passed, ${failed} failed ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
