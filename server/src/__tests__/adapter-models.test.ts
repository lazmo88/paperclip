import { beforeEach, describe, expect, it, vi } from "vitest";
import { models as codexFallbackModels } from "@paperclipai/adapter-codex-local";
import { models as cursorFallbackModels } from "@paperclipai/adapter-cursor-local";
import { resetOpenCodeModelsCacheForTests } from "@paperclipai/adapter-opencode-local/server";
import { models as qwenFallbackModels } from "@paperclipai/adapter-qwen-local";
import { resetQwenModelsCacheForTests } from "@paperclipai/adapter-qwen-local/server";
import { listAdapterModels } from "../adapters/index.js";
import { resetCodexModelsCacheForTests } from "../adapters/codex-models.js";
import { resetCursorModelsCacheForTests, setCursorModelsRunnerForTests } from "../adapters/cursor-models.js";

describe("adapter model listing", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.PAPERCLIP_QWEN_SETTINGS_PATH;
    resetCodexModelsCacheForTests();
    resetCursorModelsCacheForTests();
    setCursorModelsRunnerForTests(null);
    resetOpenCodeModelsCacheForTests();
    resetQwenModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it("returns an empty list for unknown adapters", async () => {
    const models = await listAdapterModels("unknown_adapter");
    expect(models).toEqual([]);
  });

  it("returns codex fallback models when no OpenAI key is available", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const models = await listAdapterModels("codex_local");

    expect(models).toEqual(codexFallbackModels);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads codex models dynamically and merges fallback options", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "gpt-5-pro" },
          { id: "gpt-5" },
        ],
      }),
    } as Response);

    const first = await listAdapterModels("codex_local");
    const second = await listAdapterModels("codex_local");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "gpt-5-pro")).toBe(true);
    expect(first.some((model) => model.id === "codex-mini-latest")).toBe(true);
  });

  it("falls back to static codex models when OpenAI model discovery fails", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const models = await listAdapterModels("codex_local");
    expect(models).toEqual(codexFallbackModels);
  });


  it("returns cursor fallback models when CLI discovery is unavailable", async () => {
    setCursorModelsRunnerForTests(() => ({
      status: null,
      stdout: "",
      stderr: "",
      hasError: true,
    }));

    const models = await listAdapterModels("cursor");
    expect(models).toEqual(cursorFallbackModels);
  });

  it("loads cursor models dynamically and caches them", async () => {
    const runner = vi.fn(() => ({
      status: 0,
      stdout: "Available models: auto, composer-1.5, gpt-5.3-codex-high, sonnet-4.6",
      stderr: "",
      hasError: false,
    }));
    setCursorModelsRunnerForTests(runner);

    const first = await listAdapterModels("cursor");
    const second = await listAdapterModels("cursor");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.some((model) => model.id === "auto")).toBe(true);
    expect(first.some((model) => model.id === "gpt-5.3-codex-high")).toBe(true);
    expect(first.some((model) => model.id === "composer-1")).toBe(true);
  });

  it("returns no opencode models when opencode command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    const models = await listAdapterModels("opencode_local");
    expect(models).toEqual([]);
  });

  it("returns qwen fallback models when Qwen settings discovery is unavailable", async () => {
    process.env.PAPERCLIP_QWEN_SETTINGS_PATH = "/tmp/__paperclip_missing_qwen_settings__.json";

    const models = await listAdapterModels("qwen_local");
    expect(models).toEqual(qwenFallbackModels);
  });

  it("loads qwen models from Qwen settings for the selected auth type", async () => {
    const settingsPath = `/tmp/paperclip-qwen-settings-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(
        settingsPath,
        JSON.stringify({
          modelProviders: {
            openai: [
              { id: "qwen3.5-plus", name: "[Bailian Coding Plan] qwen3.5-plus" },
              { id: "qwen3-coder-plus", name: "[Bailian Coding Plan] qwen3-coder-plus" },
              { id: "kimi-k2.5", name: "[Bailian Coding Plan] kimi-k2.5" },
            ],
            anthropic: [
              { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
            ],
          },
          security: {
            auth: {
              selectedType: "openai",
            },
          },
        }),
        "utf8",
      ),
    );
    process.env.PAPERCLIP_QWEN_SETTINGS_PATH = settingsPath;

    const first = await listAdapterModels("qwen_local");
    const second = await listAdapterModels("qwen_local");

    expect(first).toEqual(second);
    expect(first).toEqual([
      { id: "kimi-k2.5", label: "kimi-k2.5" },
      { id: "qwen3-coder-plus", label: "qwen3-coder-plus" },
      { id: "qwen3.5-plus", label: "qwen3.5-plus" },
    ]);
  });
});
