/**
 * Compatibility checks: BitBull depends on two gateways it does not control (SayGM for models,
 * Ditto for memory, Router models and tools). When one of them changes what BitBull relies on,
 * or announces that it will, the owner should be told to update before chats start failing.
 *
 * Three sources of notices, all shown in the UI (GET /api/compat) and written to Activity once:
 *
 *  1. Contract probes: the handful of responses BitBull parses (SayGM's model list; with a Router
 *     key, the Router's model list and MCP catalog, and Ditto's price catalog), checked for the
 *     fields BitBull reads. A probe failing means BitBull is guessing or broken until updated.
 *  2. Deprecation headers the gateways send (Deprecation, Sunset, Warning).
 *  3. Published notices: compat.json on BitBull's main branch, so a maintainer can warn every
 *     install about an upstream change, and whether a newer BitBull is out. A notice with
 *     `fixedIn` (a date) goes away on a build made on or after that date.
 *
 * Everything fetched here is third-party data: typed, trimmed, capped, shown as plain text.
 * See docs/COMPAT.md.
 */
import { config } from "./config.js";
import { record } from "./activity.js";
import { routerBaseUrl, routerModelId } from "./router.js";

export type NoticeLevel = "info" | "warn" | "breaking";
export type NoticeAction = "update" | "reconnect-ditto" | "settings";
export interface Notice {
  id: string;
  level: NoticeLevel;
  source: "saygm" | "ditto" | "bitbull";
  title: string;
  detail: string;
  action?: NoticeAction;
}

export interface Build {
  commit?: string;
  committed?: string;
}

/**
 * Where maintainers publish notices, and where a newer build is looked for. A fork or a
 * white-labelled build points these at its own repo in .env (not editable in Settings); "off"
 * switches one off.
 */
const NOTICES_URL = process.env.COMPAT_NOTICES_URL?.trim() || "https://raw.githubusercontent.com/bitbull-tech/BitBull/main/compat.json";
const LATEST_URL = process.env.COMPAT_LATEST_URL?.trim() || "https://api.github.com/repos/bitbull-tech/BitBull/commits/main";
const remote = (url: string) => (/^https?:\/\//.test(url) ? url : null);

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** SayGM's /models as BitBull reads it (models.ts): { data: [{ id, api_shapes, pricing… }] }. */
export function checkSaygmModels(body: unknown, defaults: { model: string; small: string }): Notice[] {
  const data = isObj(body) ? body.data : undefined;
  if (!Array.isArray(data))
    return [{ id: "saygm-models-shape", level: "breaking", source: "saygm", title: "SayGM's model list has changed format", detail: "BitBull can no longer read SayGM's model list, so model pickers and prices may be wrong or empty. Update BitBull.", action: "update" }];
  const entries = data.filter(isObj);
  const ids = new Set(entries.map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean));
  const out: Notice[] = [];
  if (entries.length && !ids.size)
    out.push({ id: "saygm-models-ids", level: "breaking", source: "saygm", title: "SayGM's model list has changed format", detail: "Models no longer carry the id BitBull expects. Update BitBull.", action: "update" });
  if (ids.size && !entries.some((m) => Array.isArray(m.api_shapes)))
    out.push({ id: "saygm-api-shapes", level: "warn", source: "saygm", title: "SayGM no longer says which API each model speaks", detail: "BitBull is guessing each model's API from its name, so some models may fail or be missing. Update BitBull when a new version is out.", action: "update" });
  for (const [what, id] of [["Default model", defaults.model], ["Small / background model", defaults.small]] as const) {
    if (id && routerModelId(id) === null && ids.size && !ids.has(id))
      out.push({ id: `saygm-missing-${id}`, level: "warn", source: "saygm", title: `${what} is no longer on SayGM`, detail: `${id} is not in SayGM's model list any more. Pick another in Settings → Configuration.`, action: "settings" });
  }
  return out;
}

/** The Router's /models as BitBull reads it (router.ts): the endpoint's own entry carries a `ditto` block. */
export function checkRouterModels(body: unknown, defaults: { model: string }): Notice[] {
  const data = Array.isArray(body) ? body : isObj(body) ? body.data : undefined;
  if (!Array.isArray(data))
    return [{ id: "router-models-shape", level: "breaking", source: "ditto", title: "Ditto Router's model list has changed format", detail: "BitBull can no longer read the Router's model list, so Router models are unavailable. SayGM models are unaffected. Update BitBull.", action: "update" }];
  const entries = data.filter(isObj);
  const self = entries.find((m) => isObj(m.ditto));
  const out: Notice[] = [];
  if (!self || typeof (self.ditto as Record<string, unknown>).record_enabled !== "boolean")
    out.push({ id: "router-endpoint-block", level: "breaking", source: "ditto", title: "Ditto Router no longer describes its endpoint", detail: "BitBull reads the endpoint's memory and tool settings from the Router's model list to keep plan mode and QA Hound out of your memory and to avoid saving turns twice. Without them, plan mode on Router models is refused. Update BitBull.", action: "update" });
  const routerDefault = routerModelId(defaults.model);
  if (routerDefault !== null && !entries.some((m) => m.id === routerDefault))
    out.push({ id: `router-missing-${routerDefault}`, level: "warn", source: "ditto", title: "Default model is no longer on your Ditto Router endpoint", detail: `${defaults.model} is not in the endpoint's model list. Pick another in Settings → Configuration.`, action: "settings" });
  return out;
}

/** The Router's /mcp catalog as BitBull reads it (router.ts): { servers: [{ name, url, tools }] }. */
export function checkMcpCatalog(body: unknown): Notice[] {
  if (isObj(body) && Array.isArray(body.servers)) return [];
  return [{ id: "router-mcp-shape", level: "breaking", source: "ditto", title: "Ditto's tool catalog has changed format", detail: "BitBull can no longer read the endpoint's tool catalog, so Ditto's tools are not attached. Update BitBull.", action: "update" }];
}

/** Deprecation, Sunset and Warning headers, as a notice. */
export function checkHeaders(source: Notice["source"], name: string, headers: Headers): Notice[] {
  const parts = [
    headers.get("deprecation") ? `deprecated${/^(true|@?\d)/i.test(headers.get("deprecation")!) ? "" : `: ${text(headers.get("deprecation"), 80)}`}` : "",
    headers.get("sunset") ? `switched off on ${text(headers.get("sunset"), 60)}` : "",
    text(headers.get("warning"), 200),
  ].filter(Boolean);
  if (!parts.length) return [];
  return [{ id: `${source}-deprecation-${name}`, level: "warn", source, title: `${source === "saygm" ? "SayGM" : "Ditto"} says part of its API is being retired`, detail: `${name}: ${parts.join("; ")}. Update BitBull before then.`, action: "update" }];
}

/**
 * compat.json from BitBull's main branch: { notices: [{ id, level, source, title, detail, fixedIn? }] }.
 * A notice with `fixedIn` (ISO date) is dropped on a build committed on or after it; with it and an
 * older (or unknown) build, the fix is to update.
 */
export function parsePublished(body: unknown, build: Build): Notice[] {
  const list = isObj(body) && Array.isArray(body.notices) ? body.notices.slice(0, 20) : [];
  const built = build.committed ? Date.parse(build.committed) : NaN;
  const out: Notice[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = text(raw.id, 60).replace(/[^A-Za-z0-9_.-]/g, "");
    const title = text(raw.title, 140);
    if (!id || !title) continue;
    const fixedIn = typeof raw.fixedIn === "string" ? Date.parse(raw.fixedIn) : NaN;
    if (Number.isFinite(fixedIn) && Number.isFinite(built) && built >= fixedIn) continue;
    const level = (["info", "warn", "breaking"] as const).find((l) => l === raw.level) ?? "warn";
    const source = (["saygm", "ditto", "bitbull"] as const).find((s) => s === raw.source) ?? "bitbull";
    out.push({ id: `published-${id}`, level, source, title, detail: text(raw.detail, 600), ...(Number.isFinite(fixedIn) ? { action: "update" as const } : {}) });
  }
  return out;
}

/** A newer commit on main than the one this build was made from. */
export function checkLatest(body: unknown, build: Build): Notice[] {
  if (!build.commit || !isObj(body)) return [];
  const sha = text(body.sha, 64);
  const date = isObj(body.commit) && isObj(body.commit.committer) ? Date.parse(text(body.commit.committer.date, 40)) : NaN;
  const built = build.committed ? Date.parse(build.committed) : NaN;
  if (!sha || sha.startsWith(build.commit) || build.commit.startsWith(sha)) return [];
  // a local build ahead of main is not "out of date"
  if (Number.isFinite(date) && Number.isFinite(built) && built >= date) return [];
  return [{ id: `update-${sha.slice(0, 10)}`, level: "info", source: "bitbull", title: "A newer BitBull is available", detail: "Update to get the latest fixes for SayGM and Ditto changes.", action: "update" }];
}

async function get(url: string, key?: string): Promise<{ status: number; headers: Headers; body: unknown }> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "BitBull", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: the checks say so */
  }
  return { status: res.status, headers: res.headers, body };
}

const keyNotice = (source: Notice["source"], id: string, title: string, detail: string, action: NoticeAction): Notice => ({ id, level: "warn", source, title, detail, action });

let last: { at: number; notices: Notice[] } = { at: 0, notices: [] };
let running: Promise<Notice[]> | null = null;
const reported = new Set<string>();

/** Run every check. A gateway that is merely unreachable is not a notice: outages are shown elsewhere. */
export async function runCompat(build: Build): Promise<Notice[]> {
  if (running) return running;
  running = (async () => {
    const notices: Notice[] = [];
    const add = async (fn: () => Promise<Notice[]>) => {
      try {
        notices.push(...(await fn()));
      } catch {
        /* unreachable right now */
      }
    };
    const defaults = { model: config.agent.defaultModel, small: config.agent.smallModel };
    await Promise.all([
      add(async () => {
        if (!config.saygm.apiKey) return [];
        const r = await get(`${config.saygm.openaiBaseUrl}/models`, config.saygm.apiKey);
        if (r.status === 401) return [keyNotice("saygm", "saygm-key", "SayGM rejected BitBull's key", "Check SAYGM_API_KEY in Settings → Integrations → SayGM.", "settings")];
        if (r.status >= 400) return [];
        return [...checkSaygmModels(r.body, defaults), ...checkHeaders("saygm", "model list", r.headers)];
      }),
      add(async () => {
        if (!config.router.key) return [];
        const r = await get(`${routerBaseUrl()}/models`, config.router.key);
        if (r.status === 401) return [keyNotice("ditto", "router-key", "Ditto Router rejected the endpoint key", "Connect Ditto again in Settings → Integrations → Ditto. SayGM models are unaffected.", "reconnect-ditto")];
        if (r.status >= 400) return [];
        return [...checkRouterModels(r.body, defaults), ...checkHeaders("ditto", "Router model list", r.headers)];
      }),
      add(async () => {
        if (!config.router.key || config.router.tools !== "on") return [];
        const r = await get(`${routerBaseUrl()}/mcp`, config.router.key);
        if (r.status >= 400) return [];
        return [...checkMcpCatalog(r.body), ...checkHeaders("ditto", "tool catalog", r.headers)];
      }),
      add(async () => {
        // the account key Connect saves lasts three months; without it Router prices and budgets stop
        if (!config.router.key || !config.ditto.apiKey) return [];
        const r = await get(`${new URL(config.ditto.mcpUrl).origin}/api/v5/inference/providers/gm/models?includeLegacy=true`, config.ditto.apiKey);
        if (r.status === 401) return [keyNotice("ditto", "ditto-account-key", "Your Ditto sign-in has expired", "The Ditto account key is no longer accepted (a Connect sign-in lasts three months). Connect Ditto again in Settings → Integrations → Ditto to keep memory, prices and provider keys working.", "reconnect-ditto")];
        if (r.status >= 400) return [];
        return isObj(r.body) && Array.isArray(r.body.models)
          ? checkHeaders("ditto", "price catalog", r.headers)
          : [{ id: "ditto-prices-shape", level: "warn", source: "ditto", title: "Ditto's price list has changed format", detail: "Costs and QA Hound budgets can't cover Ditto Router models until BitBull is updated; the endpoint's own spend limit still applies.", action: "update" }];
      }),
      add(async () => {
        const url = remote(NOTICES_URL);
        if (!url) return [];
        const r = await get(url);
        return r.status === 200 ? parsePublished(r.body, build) : [];
      }),
      add(async () => {
        const url = remote(LATEST_URL);
        if (!url) return [];
        const r = await get(url);
        return r.status === 200 ? checkLatest(r.body, build) : [];
      }),
    ]);
    const order = { breaking: 0, warn: 1, info: 2 } as const;
    notices.sort((a, b) => order[a.level] - order[b.level] || a.id.localeCompare(b.id));
    for (const n of notices) {
      if (reported.has(n.id)) continue;
      reported.add(n.id);
      record({ level: n.level === "info" ? "info" : "warn", source: "compat", message: `${n.title}: ${n.detail}` });
    }
    last = { at: Date.now(), notices };
    return notices;
  })().finally(() => {
    running = null;
  });
  return running;
}

export const compatState = () => last;

/** Check shortly after start-up, then every six hours. */
export function scheduleCompat(build: Build) {
  const go = () => void runCompat(build).catch(() => {});
  setTimeout(go, 20_000).unref();
  setInterval(go, 6 * 60 * 60 * 1000).unref();
}
