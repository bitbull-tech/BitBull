import { cachedRouterModels, cachedRouterReview, priceFor, ROUTER_PREFIX, routerModelId, routerModels, routerPrices, type RouterModel } from "./router.js";
import { redact } from "./activity.js";
import { config } from "./config.js";

export interface ModelInfo {
  id: string;
  name: string;
  /** Rough family used to route + group in the UI. */
  family: "anthropic" | "openai" | "google" | "open" | "other";
  /** Native API the gateway serves this model on (SayGM: from its api_shapes). */
  api: ModelApi;
  /** The gateway that serves it: SayGM unless it is a Ditto Router model (id `ditto-router/…`). */
  gateway?: "ditto-router";
  /** Ditto Router: the endpoint itself (or an alias) rather than a catalog model */
  endpoint?: boolean;
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
    console.error("[saygm] Couldn't load the SayGM model list:", errText(err));
    if (cache) return cache.models;
    // Minimal fallback so the app still boots offline
    const id = config.agent.defaultModel;
    return [{ id, name: id, family: familyOf(id), api: apiOf(id, null) ?? "chat" }];
  }
}

/** A Ditto Router model as a chat model. Claude models speak Messages there, the rest chat.completions. */
export function fromRouter(m: RouterModel, prices = new Map<string, NonNullable<ModelInfo["price"]>>()): ModelInfo {
  const family = familyOf(m.id);
  return {
    id: `${ROUTER_PREFIX}${m.id}`,
    name: m.name,
    family,
    api: family === "anthropic" ? "anthropic" : "chat",
    gateway: "ditto-router",
    ...(m.endpoint ? { endpoint: true } : {}),
    provider: m.owner,
    contextLength: m.contextLength,
    tools: true,
    price: priceFor(m, prices),
  };
}

/** Every chat model: SayGM's, then the Router endpoint's when a Router key is set. */
export async function chatModels(force = false): Promise<ModelInfo[]> {
  const saygm = await listModels(force);
  if (!config.router.key) return saygm;
  const [router, prices] = await Promise.all([
    routerModels(force).catch((err) => {
      console.error("[router] Couldn't load the Ditto Router model list:", errText(err));
      return cachedRouterModels();
    }),
    routerPrices(),
  ]);
  return [...saygm, ...router.map((m) => fromRouter(m, prices))];
}

export const findModel = async (id: string) => (await chatModels()).find((m) => m.id === id);

/**
 * Why a turn can't run on a Ditto Router model (null when it can). Plan mode, and so QA Hound,
 * needs the review endpoint, checked to have no memory and no tools (routerReview(), awaited by
 * the engines first), so what a reviewer reads in a possibly hostile repo never reaches memory.
 */
export function routerRefusal(id: string, known: ModelInfo | undefined, plan?: boolean): string | null {
  if (routerModelId(id) === null) return null;
  if (!known) return `${id} isn't on your Ditto Router endpoint${config.router.key ? "" : " (no Router key is set)"}. Reload the model list or pick another model.`;
  if (!plan) return null;
  const review = cachedRouterReview();
  if (!config.router.reviewKey || !review)
    return "Plan mode and QA Hound on a Ditto Router model run on the review endpoint, so what they read stays out of your memory, and there is no working review key. Connect Ditto in Settings → Integrations → Ditto (or set DITTO_ROUTER_REVIEW_KEY), or pick a SayGM model.";
  if (!review.safe)
    return `The review endpoint (${review.slug}) has memory or tools switched on, or uses the chat endpoint's key, so plan mode and QA Hound won't run on it. Turn its memory and tools off on developer.heyditto.ai, or Connect Ditto again.`;
  return null;
}

/** Estimated USD cost of a turn from the gateway's live per-model prices. */
export async function estimateCost(modelId: string, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0): Promise<number | undefined> {
  const m = await findModel(modelId);
  if (!m?.price) return undefined;
  // cache reads are billed at their own (lower) rate when the gateway publishes one
  const cacheRate = m.price.cacheRead ?? m.price.input;
  return (Math.max(0, inputTokens - cacheReadTokens) * m.price.input + cacheReadTokens * cacheRate + outputTokens * m.price.output) / 1e6;
}

/** Model list for clients, without the raw gateway payload. */
export async function publicModels(force = false) {
  return (await chatModels(force)).map(({ raw: _raw, ...rest }) => rest);
}

/**
 * One model, with the gateway's own record attached. This is the only place `raw` leaves the
 * server: the Models view shows what SayGM publishes, so you don't have to go to SayGM to
 * read it. Redacted like anything else user-visible, since the record is third-party data.
 */
export async function modelDetail(id: string, force = false) {
  const m = (await chatModels(force)).find((x) => x.id === id);
  if (!m) return null;
  return JSON.parse(redact(JSON.stringify(m))) as ModelInfo;
}

/** fetch() errors hide the real reason (DNS, refused, TLS, proxy) in .cause */
export function errText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  const c = cause instanceof Error ? `${(cause as Error & { code?: string }).code ?? cause.name}: ${cause.message}` : cause ? String(cause) : "";
  return c ? `${err.message} (${c})` : err.message;
}
