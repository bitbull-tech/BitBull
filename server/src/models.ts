import { config } from "./config.js";

export interface ModelInfo {
  id: string;
  name: string;
  /** Rough family used to route + group in the UI. */
  family: "anthropic" | "openai" | "google" | "open" | "other";
  /** Native API SayGM serves this model on (from its api_shapes). */
  api: ModelApi;
  contextLength?: number;
  /** Who makes it (owned_by), e.g. anthropic, openai, moonshot. */
  provider?: string;
  tier?: string;
  /** Runs inside a TEE (private inference). */
  confidential?: boolean;
  vision?: boolean;
  tools?: boolean;
  /** Current SayGM price, USD per million tokens. */
  price?: { input: number; output: number; cacheRead?: number };
  /** Published retail price, USD per million tokens. */
  retail?: { input: number; output: number };
  /** % below retail on blended input+output price. */
  savingsPct?: number;
  raw?: Record<string, unknown>;
}

type Dims = Record<string, number | undefined>;
const perM = (nd?: number) => (typeof nd === "number" ? nd / 1e9 : undefined);

function pricing(m: Record<string, any>) {
  const cur: Dims | undefined = m.pricing?.dimensions;
  const ret: Dims | undefined = m.price_range?.ceiling?.dimensions;
  const price =
    cur && perM(cur.input_per_mtok_ndollars) !== undefined
      ? { input: perM(cur.input_per_mtok_ndollars)!, output: perM(cur.output_per_mtok_ndollars) ?? 0, cacheRead: perM(cur.cache_read_per_mtok_ndollars) }
      : undefined;
  const retail =
    ret && perM(ret.input_per_mtok_ndollars) !== undefined
      ? { input: perM(ret.input_per_mtok_ndollars)!, output: perM(ret.output_per_mtok_ndollars) ?? 0 }
      : undefined;
  let savingsPct: number | undefined;
  if (price && retail) {
    // Blend 3:1 input:output, a typical agent mix
    const blend = (p: { input: number; output: number }) => 3 * p.input + p.output;
    if (blend(retail) > 0) savingsPct = Math.max(0, Math.round((1 - blend(price) / blend(retail)) * 100));
  }
  return { price, retail, savingsPct };
}

export type ModelApi = "anthropic" | "responses" | "google" | "chat";

/** Prefer each model's native API: richer tool calling + reasoning than chat.completions. */
export function apiOf(id: string, shapes: unknown): ModelApi | null {
  const sh = Array.isArray(shapes) ? shapes.map(String) : [];
  if (sh.includes("messages")) return "anthropic";
  if (sh.includes("responses")) return "responses";
  if (sh.includes("generateContent") || sh.includes("streamGenerateContent")) return "google";
  if (sh.includes("chat.completions")) return "chat";
  if (sh.length) return null; // e.g. images.generations only — not a chat model
  const f = familyOf(id); // gateway didn't say: guess from the name
  return f === "anthropic" ? "anthropic" : f === "google" ? "google" : "chat";
}

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5", "gemini-3.5-flash" -> "Gemini 3.5 Flash" */
export function prettyName(id: string) {
  if (/^o\d/.test(id)) return id;
  const parts = id.split("-");
  const out: string[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (/^\d+(\.\d+)?$/.test(p) && prev && /\d$/.test(prev) && p.length <= 2) out[out.length - 1] = `${prev}.${p}`;
    else if (p === "tee") out.push("(TEE)");
    else out.push(/^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p);
  }
  return out.join(" ").replace(/^Gpt\b/, "GPT");
}

let cache: { at: number; models: ModelInfo[] } | null = null;
const TTL = 10 * 60 * 1000;

export function familyOf(id: string): ModelInfo["family"] {
  const s = id.toLowerCase();
  if (s.includes("claude") || s.startsWith("anthropic/")) return "anthropic";
  if (/(^|\/)(gpt|o\d|chatgpt|openai)/.test(s)) return "openai";
  if (s.includes("gemini") || s.startsWith("google/")) return "google";
  if (/(llama|qwen|deepseek|mistral|mixtral|kimi|glm|gemma|phi|nemotron|minimax|gpt-oss)/.test(s)) return "open";
  return "other";
}

/** Live model list from SayGM's OpenAI-compatible /models endpoint. */
export async function listModels(force = false): Promise<ModelInfo[]> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.models;
  try {
    const res = await fetch(`${config.saygm.openaiBaseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.saygm.apiKey}` },
    });
    if (!res.ok) throw new Error(`SayGM /models ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const models: ModelInfo[] = (body.data ?? []).flatMap((m) => {
      const id = String(m.id);
      const api = apiOf(id, m.api_shapes);
      if (!api || /image/i.test(id)) return []; // chat UI only lists text models
      if (m.available === false) return [];
      const caps = (m.capabilities ?? {}) as Record<string, unknown>;
      return [{
        id,
        name: String(m.display_name ?? (m.name && m.name !== id ? m.name : prettyName(id))),
        family: familyOf(id),
        api,
        contextLength: Number(m.context_length ?? m.context_window ?? 0) || undefined,
        provider: m.owned_by ? String(m.owned_by) : undefined,
        tier: m.tier ? String(m.tier) : undefined,
        confidential: m.confidential === true || /-tee$/.test(id),
        vision: caps.vision === true,
        tools: caps.tools !== false,
        ...pricing(m as Record<string, any>),
        raw: m,
      }];
    });
    models.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));
    cache = { at: Date.now(), models };
    return models;
  } catch (err) {
    console.error("[models]", err instanceof Error ? err.message : err);
    if (cache) return cache.models;
    // Minimal fallback so the app still boots offline
    const id = config.agent.defaultModel;
    return [{ id, name: id, family: familyOf(id), api: apiOf(id, null) ?? "chat" }];
  }
}

/** Estimated USD cost of a turn from SayGM's live per-model prices. */
export async function estimateCost(modelId: string, inputTokens = 0, outputTokens = 0): Promise<number | undefined> {
  const m = (await listModels()).find((x) => x.id === modelId);
  if (!m?.price) return undefined;
  return (inputTokens * m.price.input + outputTokens * m.price.output) / 1e6;
}

/** Model list for clients, without the raw gateway payload. */
export async function publicModels(force = false) {
  return (await listModels(force)).map(({ raw: _raw, ...rest }) => rest);
}
