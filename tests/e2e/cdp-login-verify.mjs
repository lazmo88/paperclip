#!/usr/bin/env node
/**
 * CDP-based login and OpenClaw adapter verification
 * 1. Log in via better-auth API
 * 2. Set session cookie in browser via CDP
 * 3. Navigate to agents page
 * 4. Find an OpenClaw agent and inspect its config
 */

import http from "node:http";
import { randomUUID } from "node:crypto";

const CDP_WS = "ws://localhost:9222/devtools/page/04782BE44C67BC1ED040EC83DB9FB506";
const BASE = "http://localhost:3100";

// Minimal CDP client using raw WebSocket
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const key = Buffer.from(randomUUID()).toString("base64");
    const url = new URL(wsUrl);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });

    req.on("upgrade", (_res, socket) => {
      let msgId = 1;
      const pending = new Map();
      let buf = Buffer.alloc(0);

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          let payloadLen = buf[1] & 0x7f;
          let offset = 2;
          if (payloadLen === 126) { if (buf.length < 4) return; payloadLen = buf.readUInt16BE(2); offset = 4; }
          else if (payloadLen === 127) { if (buf.length < 10) return; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
          if (buf.length < offset + payloadLen) return;
          const payload = buf.slice(offset, offset + payloadLen);
          buf = buf.slice(offset + payloadLen);
          const opcode = buf.length > 0 ? (buf[0] ?? 0) & 0x0f : (chunk[0] ?? 0) & 0x0f;
          try {
            const msg = JSON.parse(payload.toString("utf8"));
            if (msg.id && pending.has(msg.id)) {
              pending.get(msg.id)(msg);
              pending.delete(msg.id);
            }
          } catch {}
        }
      });

      const send = (method, params = {}) => {
        return new Promise((res) => {
          const id = msgId++;
          pending.set(id, res);
          const data = Buffer.from(JSON.stringify({ id, method, params }));
          const frame = Buffer.alloc(6 + data.length);
          frame[0] = 0x81;
          frame[1] = 0x80 | data.length;
          frame[2] = 0; frame[3] = 0; frame[4] = 0; frame[5] = 0;
          data.copy(frame, 6);
          socket.write(frame);
          setTimeout(() => { pending.delete(id); res({ error: "timeout" }); }, 15000);
        });
      };

      const close = () => socket.end();
      resolve({ send, close });
    });

    req.on("error", reject);
    req.end();
  });
}

async function main() {
  console.log("=== CDP Login & OpenClaw Adapter Verification ===\n");

  // Step 1: Login via API
  console.log("1. Logging in via better-auth API...");
  const loginRes = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "e2e-verify@test.com", password: "TestPass123!" }),
  });
  const loginData = await loginRes.json();
  
  if (!loginData.token) {
    console.error("Login failed:", loginData);
    process.exit(1);
  }
  console.log(`   Token: ${loginData.token.slice(0, 8)}...`);
  console.log(`   User: ${loginData.user.name} (${loginData.user.email})`);

  // Get cookies from login response
  const cookies = loginRes.headers.getSetCookie?.() || [];
  console.log(`   Cookies: ${cookies.length} set-cookie headers`);

  // Step 2: Connect CDP and set cookies
  console.log("\n2. Setting auth cookies via CDP...");
  const cdp = await cdpConnect(CDP_WS);
  
  // Set the session cookie 
  for (const cookie of cookies) {
    const [nameVal] = cookie.split(";");
    const [name, ...valParts] = nameVal.split("=");
    const value = valParts.join("=");
    await cdp.send("Network.setCookie", {
      name: name.trim(),
      value: value.trim(),
      domain: "localhost",
      path: "/",
    });
    console.log(`   Set cookie: ${name.trim()}`);
  }

  // Also set via bearer token in case needed
  // Navigate to agents page
  console.log("\n3. Navigating to agents page...");
  await cdp.send("Page.navigate", { url: `${BASE}/agents` });
  await new Promise(r => setTimeout(r, 5000)); // wait for page load

  // Step 4: Check page content
  console.log("\n4. Checking page content...");
  const evalResult = await cdp.send("Runtime.evaluate", {
    expression: `document.body?.innerText?.slice(0, 500)`,
    returnByValue: true,
  });
  console.log("   Page text:", evalResult.result?.result?.value?.slice(0, 200) || "empty");

  // Check for OpenClaw references
  const openclawCheck = await cdp.send("Runtime.evaluate", {
    expression: `document.body?.innerHTML?.includes('openclaw') || document.body?.innerHTML?.includes('OpenClaw')`,
    returnByValue: true,
  });
  console.log("   Has OpenClaw ref:", openclawCheck.result?.result?.value);

  // Check for agent links
  const agentLinks = await cdp.send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('a[href*="agent"]')).map(a => a.textContent?.trim()).filter(Boolean).slice(0,10).join(', ')`,
    returnByValue: true,
  });
  console.log("   Agent links:", agentLinks.result?.result?.value || "none");

  // Check console errors
  const consoleErrors = await cdp.send("Runtime.evaluate", {
    expression: `window.__consoleErrors?.join('\\n') || '(none tracked)'`,
    returnByValue: true,
  });
  console.log("   Console errors:", consoleErrors.result?.result?.value);

  // Take screenshot
  console.log("\n5. Taking screenshot...");
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
  if (screenshot.result?.data) {
    const fs = await import("node:fs");
    fs.writeFileSync("/home/openclaw/.openclaw/workspace/serve/paperclip-agents-verify.png", 
      Buffer.from(screenshot.result.data, "base64"));
    console.log("   Saved: https://serve.lasse.dev/paperclip-agents-verify.png");
  }

  cdp.close();
  console.log("\n=== Done ===");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
