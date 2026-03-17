import { describe, expect, it } from "vitest";
import { isQwenUnknownSessionError, parseQwenStreamJson } from "./parse.js";

describe("qwen parser", () => {
  it("extracts session, summary, usage, and errors from stream-json output", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "session_start", sessionId: "qwen-ses-1", model: "qwen3-coder-plus" }),
      JSON.stringify({ type: "assistant", message: { content: "hello" } }),
      JSON.stringify({
        type: "result",
        summary: "completed",
        usage: { inputTokens: 12, outputTokens: 7, cachedInputTokens: 3, costUsd: 0.0012 },
      }),
      JSON.stringify({ type: "error", message: "bad auth" }),
    ].join("\n");

    const parsed = parseQwenStreamJson(stdout);
    expect(parsed.sessionId).toBe("qwen-ses-1");
    expect(parsed.model).toBe("qwen3-coder-plus");
    expect(parsed.summary).toBe("hello");
    expect(parsed.usage).toEqual({
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 7,
    });
    expect(parsed.costUsd).toBe(0.0012);
    expect(parsed.errorMessage).toBe("bad auth");
  });

  it("reads assistant text from top-level parts arrays", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        parts: [{ text: "hello" }, { text: "from parts" }],
      }),
      JSON.stringify({
        type: "result",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ].join("\n");

    const parsed = parseQwenStreamJson(stdout);
    expect(parsed.summary).toBe("hello\nfrom parts");
  });

  it("retains result-only summary text when no assistant chunk is emitted", () => {
    const stdout = [
      JSON.stringify({
        type: "result",
        result: { summary: "completed from result" },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ].join("\n");

    const parsed = parseQwenStreamJson(stdout);
    expect(parsed.summary).toBe("completed from result");
  });

  it("detects unknown resume-session failures", () => {
    expect(isQwenUnknownSessionError("", "Error: unknown session id abc")).toBe(true);
    expect(isQwenUnknownSessionError("", "cannot resume session")).toBe(true);
    expect(isQwenUnknownSessionError("ok", "")).toBe(false);
  });

  it("calculates cost from tokens when costUsd is not returned (subscription plans)", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "session_start", sessionId: "qwen-ses-1", model: "qwen3-coder-plus" }),
      JSON.stringify({
        type: "result",
        summary: "completed",
        usage: { inputTokens: 1000, outputTokens: 500 },
        // No costUsd - simulates subscription plan
      }),
    ].join("\n");

    const parsed = parseQwenStreamJson(stdout);
    expect(parsed.model).toBe("qwen3-coder-plus");
    expect(parsed.usage.inputTokens).toBe(1000);
    expect(parsed.usage.outputTokens).toBe(500);
    // qwen3-coder-plus: input $0.0000006/token, output $0.0000024/token
    // Expected: 1000 * 0.0000006 + 500 * 0.0000024 = 0.0006 + 0.0012 = 0.0018
    expect(parsed.costUsd).toBeCloseTo(0.0018, 6);
  });

  it("uses returned costUsd when available instead of calculating from tokens", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "session_start", sessionId: "qwen-ses-1", model: "qwen3-coder-plus" }),
      JSON.stringify({
        type: "result",
        summary: "completed",
        usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.002 },
      }),
    ].join("\n");

    const parsed = parseQwenStreamJson(stdout);
    // Should use the returned cost, not calculate
    expect(parsed.costUsd).toBe(0.002);
  });
});
