/**
 * Ditto Router (router.heyditto.ai): an optional, OpenAI-compatible route for BitBull's
 * background work. Chats stay on SayGM; when Configuration → "Background work runs on" is
 * ditto-router, the OpenCode engine's small model (titles, compaction and other housekeeping)
 * is served by the Router model chosen there. See docs/ROUTER.md.
 *
 * The key is a Router endpoint key (ditto_inf_…). It never reaches the agent's environment: it
 * travels in OpenCode's config like the SayGM key, and is scrubbed from the engine's environ.
 */
import { config } from "./config.js";

export interface RouterModel {
  id: string;
  name: string;
  /** $ per million tokens, when the Router says */
  price?: { input: number; output: number };
  contextLength?: number;
  owner?: string;
}

let cache: { at: number; key: string; models: RouterModel[] } | null = null;
const TTL = 10 * 60 * 1000;

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

/** Prices come per token (OpenRouter style "0.00000015") or per million; normalise to $/M. */
function priceOf(m: Record<string, unknown>): RouterModel["price"] {
  const p = (m.pricing ?? m.price ?? m.prices) as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return undefined;
  let input = num(p.prompt ?? p.input ?? p.input_per_million ?? p.inputPerMillion);
  let output = num(p.completion ?? p.output ?? p.output_per_million ?? p.outputPerMillion);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  // per-token figures are tiny; anything under $0.01 a token is per token
  if (input < 0.01 && output < 0.01) (input *= 1e6), (output *= 1e6);
  return { input: Math.round(input * 1000) / 1000, output: Math.round(output * 1000) / 1000 };
}

export function parseRouterModels(body: unknown): RouterModel[] {
  const list = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [];
  const out: RouterModel[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || id.length > 200) continue;
    const ctx = num(m.context_length ?? m.contextLength ?? (m.top_provider as Record<string, unknown> | undefined)?.context_length);
    out.push({
      id,
      name: typeof m.name === "string" && m.name ? m.name.slice(0, 120) : id,
      price: priceOf(m),
      contextLength: Number.isFinite(ctx) ? ctx : undefined,
      owner: typeof m.owned_by === "string" ? m.owned_by : undefined,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The Router's model list for this key (cached for ten minutes). */
export async function routerModels(refresh = false): Promise<RouterModel[]> {
  const key = config.router.key;
  if (!key) throw new Error("No Ditto Router key: add one under Integrations → Ditto");
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < TTL) return cache.models;
  const res = await fetch(`${config.router.baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(`Ditto Router said ${res.status}${msg ? `: ${msg}` : ""}`);
  }
  const models = parseRouterModels(await res.json());
  cache = { at: Date.now(), key, models };
  return models;
}

/** The cached list without a network call (for code that must not wait). */
export const cachedRouterModels = () => (cache && cache.key === config.router.key ? cache.models : []);

/** Background work goes to the Router when it is chosen, keyed and has a model. */
export function routerBackground(): { model: string } | null {
  const r = config.router;
  return r.background === "ditto-router" && r.key && r.model ? { model: r.model } : null;
}

/** The same model on the Router and SayGM: ids match after any "provider/" prefix and case. */
export const sameModel = (a: string, b: string) => a.split("/").pop()!.toLowerCase() === b.split("/").pop()!.toLowerCase();
