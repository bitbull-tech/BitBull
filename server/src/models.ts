import { config } from "./config.js";

export interface ModelInfo {
  id: string;
  name: string;
  /** Rough family used to route + group in the UI. */
  family: "anthropic" | "openai" | "google" | "open" | "other";
  /** Native API SayGM serves this model on (from its api_shapes). */
  api: ModelApi;
  contextLength?: number;
  raw?: Record<string, unknown>;
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
      return [{
        id,
        name: String(m.name ?? m.display_name ?? id),
        family: familyOf(id),
        api,
        contextLength: Number(m.context_length ?? m.context_window ?? 0) || undefined,
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
