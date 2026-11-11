/**
 * Ditto Router (router.heyditto.ai): a second model gateway next to SayGM. With a Router endpoint
 * key, the endpoint's models join the model list as `ditto-router/<id>` and run in chats, QA Hound
 * and subagents on either engine; background work can move to a Router model too
 * (Configuration → "Background work runs on"). See docs/ROUTER.md.
 *
 * The key is a Router endpoint key (ditto_inf_…). It never reaches the agent's environment: it
 * travels in the engines' own config like the SayGM key, and is scrubbed from their environ.
 */
import { config } from "./config.js";

export interface RouterModel {
  id: string;
  name: string;
  /** $ per million tokens, when the Router says */
  price?: { input: number; output: number };
  contextLength?: number;
  owner?: string;
  /** The endpoint itself (its slug) or one of its aliases, rather than a catalog model */
  endpoint?: boolean;
  /** The endpoint's own entry: the model it routes to, its memory settings and its tool count */
  routesTo?: string;
  records?: boolean;
  recalls?: boolean;
  tools?: number;
}

/** BitBull's id for a Router model is the Router's own id behind this prefix, so it never clashes with SayGM's. */
export const ROUTER_PREFIX = "ditto-router/";

/** The Router's own id for a BitBull model id, or null when the model is not on the Router. */
export const routerModelId = (id: string) => (id.startsWith(ROUTER_PREFIX) ? id.slice(ROUTER_PREFIX.length) : null);

/**
 * The Router serves Anthropic Messages, OpenAI Responses and chat.completions under one /v1, and
 * translates between them: any of its models works on any of them.
 */
export const routerBaseUrl = () => config.router.baseUrl.replace(/\/+$/, "");

/**
 * Header the Router groups a conversation's requests by, one Router thread per BitBull chat.
 * Without it, every chat's requests within ten minutes of each other share a thread.
 * (Set per request: engines/claude.ts, and agent/opencode-plugin/ditto-router.js for OpenCode.)
 */
export const ROUTER_SESSION_HEADER = "X-Ditto-Session-Id";

/**
 * Sent on every Router request: BitBull attaches its own tools, so the Router must not add the
 * endpoint's server-side tools. Those would run on Ditto as the key holder, outside BitBull's
 * fences (plan mode's no-MCP rule, project integrations). It can only remove tools.
 */
export const ROUTER_HEADERS = { "X-Ditto-Tool-Surface": "mcp" } as const;

const TTL = 10 * 60 * 1000;
const RETRY = 60 * 1000;

/**
 * One value per key, kept for ten minutes. After a failure the last good value stays readable
 * (peek) and the fetch is retried after a minute, not on every call, so a Router outage never
 * stalls every turn.
 */
function keyed<T>(empty: T) {
  let c: { at: number; key: string; value: T; error?: unknown } | null = null;
  return {
    async get(key: string, fetch: () => Promise<T>, refresh = false): Promise<T> {
      if (!refresh && c && c.key === key && Date.now() - c.at < (c.error ? RETRY : TTL)) {
        if (c.error) throw c.error;
        return c.value;
      }
      try {
        const value = await fetch();
        c = { at: Date.now(), key, value };
        return value;
      } catch (error) {
        c = { at: Date.now(), key, value: c?.key === key ? c.value : empty, error };
        throw error;
      }
    },
    peek: (key: string) => (c && c.key === key ? c.value : empty),
  };
}

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
    const ditto = m.ditto as Record<string, unknown> | undefined;
    const id = typeof m.id === "string" ? m.id : "";
    if (!id || id.length > 200) continue;
    const ctx = num(m.context_length ?? m.contextLength ?? (m.top_provider as Record<string, unknown> | undefined)?.context_length);
    // the endpoint's own entry (its slug) names itself in its ditto block
    const label = [m.name, ditto?.name].find((v): v is string => typeof v === "string" && v !== "");
    out.push({
      id,
      name: (label ?? id).slice(0, 120),
      price: priceOf(m),
      contextLength: Number.isFinite(ctx) ? ctx : undefined,
      owner: typeof m.owned_by === "string" ? m.owned_by : undefined,
      ...(ditto && typeof ditto === "object" ? { endpoint: true } : {}),
      ...(typeof ditto?.model === "string" && ditto.model ? { routesTo: ditto.model } : {}),
      ...(typeof ditto?.record_enabled === "boolean" ? { records: ditto.record_enabled } : {}),
      ...(typeof ditto?.recall_enabled === "boolean" ? { recalls: ditto.recall_enabled } : {}),
      ...(Array.isArray(ditto?.tools) ? { tools: ditto.tools.length } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** GET a Router path with the endpoint key; the Router's own error message on failure. */
async function routerGet(pathname: string, key: string): Promise<unknown> {
  const res = await fetch(`${routerBaseUrl()}${pathname}`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
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
  return res.json();
}

const models = keyed<RouterModel[]>([]);

/** The Router's model list for the chat key. */
export async function routerModels(refresh = false): Promise<RouterModel[]> {
  const key = config.router.key;
  if (!key) throw new Error("No Ditto Router key: add one under Integrations → Ditto");
  return models.get(key, async () => parseRouterModels(await routerGet("/models", key)), refresh);
}

/** The last list fetched for this key, however old, without a network call. */
export const cachedRouterModels = () => models.peek(config.router.key);

/**
 * The review endpoint, as its own key sees it: its slug (what the chat endpoint's own entry maps
 * to in plan mode) and whether it is fit for plan mode: no memory either way and no tools, and not
 * the chat key pasted twice. Checked on every refresh, not only at Connect, since its settings can
 * be changed on developer.heyditto.ai.
 */
export interface RouterReview {
  slug: string;
  safe: boolean;
}
const review = keyed<RouterReview | null>(null);

export async function routerReview(refresh = false): Promise<RouterReview | null> {
  const key = config.router.reviewKey;
  if (!key) return null;
  return review
    .get(
      key,
      async () => {
        const self = parseRouterModels(await routerGet("/models", key)).find((m) => m.endpoint && m.recalls !== undefined);
        if (!self) return null;
        return { slug: self.id, safe: key !== config.router.key && self.recalls === false && self.records === false && !self.tools };
      },
      refresh,
    )
    .catch((err) => {
      console.warn("[router] Couldn't check the review endpoint:", err instanceof Error ? err.message : err);
      return review.peek(key);
    });
}

export const cachedRouterReview = () => (config.router.reviewKey ? review.peek(config.router.reviewKey) : null);

/**
 * The Router's id for a model on the review endpoint: catalog models keep theirs; the chat
 * endpoint itself (and its aliases) become the review endpoint, which routes to its own model.
 */
export const reviewModelId = (m: Pick<RouterModel, "id" | "endpoint">) => (m.endpoint ? (cachedRouterReview()?.slug ?? m.id) : m.id);

/**
 * Prices for Router models. The Router's /v1/models has none, so they come from Ditto's model
 * catalog, read with the account key (DITTO_API_KEY): USD per token as decimal strings there,
 * $ per million tokens here, keyed by model name without its "vendor/" part.
 */
type Price = NonNullable<RouterModel["price"]> & { cacheRead?: number };
const prices = keyed(new Map<string, Price>());

export function parsePrices(body: unknown): Map<string, Price> {
  const prices = new Map<string, Price>();
  const list = (body as { models?: unknown })?.models;
  for (const m of Array.isArray(list) ? (list as Array<Record<string, unknown>>) : []) {
    const p = m?.pricing as Record<string, unknown> | undefined;
    const input = num(p?.prompt);
    const output = num(p?.completion);
    if (typeof m?.id !== "string" || !Number.isFinite(input) || !Number.isFinite(output)) continue;
    const cache = num(p?.input_cache_read);
    const perM = (n: number) => Math.round(n * 1e9) / 1e3;
    prices.set(modelKey(m.id), { input: perM(input), output: perM(output), ...(Number.isFinite(cache) ? { cacheRead: perM(cache) } : {}) });
  }
  return prices;
}

const modelKey = (id: string) => id.split("/").pop()!.toLowerCase();

export async function routerPrices(): Promise<Map<string, Price>> {
  const key = config.ditto.apiKey;
  if (!key || !config.router.key) return new Map();
  return prices
    .get(key, async () => {
      const res = await fetch(`${new URL(config.ditto.mcpUrl).origin}/api/v5/inference/providers/gm/models?includeLegacy=true`, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Ditto said ${res.status}`);
      return parsePrices(await res.json());
    })
    .catch((err) => {
      console.warn("[router] Couldn't load Ditto's model prices:", err instanceof Error ? err.message : err);
      return prices.peek(key);
    });
}

/** A Router model's price: its own, else the catalog's for the model it is (or routes to). */
export const priceFor = (m: RouterModel, prices: Map<string, Price>) => m.price ?? prices.get(modelKey(m.routesTo ?? m.id));

/** The chat endpoint records its turns into Ditto memory itself (so BitBull doesn't archive them again). */
export const routerRecords = () => cachedRouterModels().some((m) => m.records === true);

/** Background work goes to the Router when it is chosen, keyed and has a model. */
export function routerBackground(): { model: string } | null {
  const r = config.router;
  return r.background === "ditto-router" && r.key && r.model ? { model: r.model } : null;
}

/** The same model on the Router and SayGM: ids match after any "provider/" prefix and case. */
export const sameModel = (a: string, b: string) => a.split("/").pop()!.toLowerCase() === b.split("/").pop()!.toLowerCase();

/**
 * The endpoint's tools as MCP servers BitBull attaches itself (GET /v1/mcp, the catalog
 * `heyditto claude` attaches): Ditto's built-ins (memory) as "ditto", each connected app or
 * MCP server as "ditto-<source>". Calls run on Ditto (/v1/mcp/<server>) with the credentials
 * Ditto holds, behind the endpoint's approval gate. Attached by BitBull rather than injected by
 * the Router, so BitBull's own fences apply: none in plan mode, none of them shell-reachable.
 */
export interface RouterMcpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
  /**
   * Tools Ditto would hold for a person on an endpoint with client approvals: there the client
   * must ask, and BitBull has nobody to ask mid-turn, so they are refused.
   */
  deny: string[];
}

/** Names every engine's config can carry as a key and tool prefix; the backend only serves these. */
const SAFE_SERVER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** The catalog's servers, sorted so the same catalog always gives the same OpenCode config. */
export function parseMcpCatalog(body: unknown, key: string): RouterMcpServer[] {
  const catalog = body as { clientApprovals?: unknown; servers?: unknown };
  if (!catalog || !Array.isArray(catalog.servers)) throw new Error("Ditto Router: /mcp is not an MCP catalog");
  const out: RouterMcpServer[] = [];
  for (const raw of catalog.servers as Array<Record<string, unknown>>) {
    const tools = Array.isArray(raw?.tools) ? (raw.tools as Array<{ name?: unknown; approval?: unknown }>) : [];
    if (typeof raw?.name !== "string" || !SAFE_SERVER.test(raw.name) || typeof raw.url !== "string" || !tools.length) continue;
    out.push({
      name: raw.name === "ditto" ? "ditto" : `ditto-${raw.name}`,
      url: raw.url,
      headers: { Authorization: `Bearer ${key}` },
      deny: catalog.clientApprovals === true ? tools.filter((t) => t.approval === true && typeof t.name === "string").map((t) => String(t.name)).sort() : [],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const mcp = keyed<RouterMcpServer[]>([]);

/** The chat endpoint's MCP servers (the last good list while the Router is down). */
export async function routerMcpServers(refresh = false): Promise<RouterMcpServer[]> {
  const key = config.router.key;
  if (!key) return [];
  return mcp.get(key, async () => parseMcpCatalog(await routerGet("/mcp", key), key), refresh).catch((err) => {
    console.warn("[router] Couldn't load the endpoint's MCP servers:", err instanceof Error ? err.message : err);
    return mcp.peek(key);
  });
}

