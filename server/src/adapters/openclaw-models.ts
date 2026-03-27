import type { AdapterModel } from "./types.js";
import { gatewayRpc, type GatewayRpcResult } from "@paperclipai/adapter-openclaw-gateway/server";

/**
 * Fetch available models from an OpenClaw gateway via WebSocket RPC.
 *
 * Uses OPENCLAW_WS_URL (default ws://localhost:18799/v1/ws) and optional
 * OPENCLAW_TOKEN env vars. Results are cached for 60 seconds.
 */

const CACHE_TTL_MS = 60_000;
const CONNECT_TIMEOUT_MS = 8_000;

const cacheByUrl = new Map<string, { expiresAt: number; models: AdapterModel[] }>();

function resolveWsUrl(): string {
  return (
    process.env.OPENCLAW_WS_URL?.trim() ||
    (process.env.OPENCLAW_GATEWAY_PORT
      ? `ws://localhost:${process.env.OPENCLAW_GATEWAY_PORT}/v1/ws`
      : "ws://localhost:18799/v1/ws")
  );
}

function resolveToken(): string | null {
  return (
    process.env.OPENCLAW_TOKEN?.trim() ||
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    null
  );
}

interface GatewayModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
}

function toAdapterModel(m: GatewayModel): AdapterModel {
  const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : "";
  const reasoning = m.reasoning ? " 🧠" : "";
  return {
    id: `${m.provider}/${m.id}`,
    label: `${m.provider}/${m.name}${ctx}${reasoning}`,
  };
}

export async function listOpenClawModels(): Promise<AdapterModel[]> {
  const wsUrl = resolveWsUrl();
  const entry = cacheByUrl.get(wsUrl);
  if (entry && Date.now() < entry.expiresAt) return entry.models;

  // Use the shared gateway RPC flow which handles token and device auth with auto-pairing
  const token = resolveToken();
  const result = await gatewayRpc<{ models: GatewayModel[] }>(
    { url: wsUrl, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) },
    "models.list",
    {},
    CONNECT_TIMEOUT_MS
  );

  const models = result.ok
    ? (result.payload.models ?? []).map(toAdapterModel)
    : [];

  if (models.length > 0) {
    cacheByUrl.set(wsUrl, { expiresAt: Date.now() + CACHE_TTL_MS, models });
  }
  return models;
}

export function resetOpenClawModelsCacheForTests(): void {
  cacheByUrl.clear();
}