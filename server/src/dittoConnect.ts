/**
 * Connect Ditto: one sign-in sets BitBull up on Ditto (docs/ROUTER.md).
 *
 * Ditto's device login (what `heyditto login` does) gives an account key; with it BitBull
 * creates, or reuses, two Ditto Router endpoints and mints a key for each:
 *
 *  - "bitbull" for chats: memory recall and recording, and every tool the account has connected
 *    (Ditto's memory tools, GitHub, Gmail, …), which BitBull attaches as MCP servers (router.ts);
 *  - "bitbull-review" for plan mode and QA Hound, which read possibly hostile code: no memory and
 *    no tools, enforced again on every connect.
 *
 * The keys are saved like keys typed into Settings (the vault when it is unlocked), and Ditto
 * becomes the default: the "bitbull" endpoint is the default model and does background work.
 * Nothing here reaches the web UI except the sign-in code and link.
 *
 * The sign-in asks for key access too (device intent "keys"), so Settings can save provider keys
 * to Ditto (providerKeys.ts), and new endpoints bill to those keys first, then Ditto credits.
 */
import os from "node:os";
import { config } from "./config.js";
import { record } from "./activity.js";
import { ROUTER_PREFIX, routerMcpServers, routerModels, routerReview } from "./router.js";
import { updateSettings } from "./settings.js";

export const CHAT_ENDPOINT = "bitbull";
export const REVIEW_ENDPOINT = "bitbull-review";

/** Where the account connects GitHub, Gmail, Linear, … (the "bitbull" endpoint offers them all). */
export const CONNECTIONS_URL = "https://app.heyditto.ai/connections/apps";

/** Endpoint settings that make sense for BitBull (POST /api/v5/inference/endpoints). */
const ENDPOINTS = {
  [CHAT_ENDPOINT]: { name: "BitBull", tools: ["*"], recallEnabled: true, recordEnabled: true },
  // re-applied to an existing endpoint too: this one must never remember what it reads
  [REVIEW_ENDPOINT]: { name: "BitBull review", tools: [], recallEnabled: false, recordEnabled: false, recordAttachments: false, recordTrace: false },
} as const;

export type ConnectState =
  | { status: "idle" }
  | { status: "waiting"; userCode: string; url: string; expiresAt: number }
  | { status: "connected"; endpoint: string }
  | { status: "error"; message: string };

let state: ConnectState = { status: "idle" };
let attempt = 0;

export const connectState = () => state;

/** Ditto's API: the origin of its MCP URL (api.heyditto.ai). */
const apiBase = () => new URL(config.ditto.mcpUrl).origin;

async function dittoApi<T>(path: string, init: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body = {} as T & { error?: unknown; message?: unknown };
  try {
    if (text) body = JSON.parse(text);
  } catch {
    if (res.ok) throw new Error(`Ditto sent something that isn't JSON from ${path}`);
  }
  // the device-token poll answers 400 with an OAuth error while it waits
  if (!res.ok && !(path.endsWith("/device-token") && typeof body.error === "string")) {
    const msg = [body.message, body.error].find((v): v is string => typeof v === "string") ?? res.statusText;
    throw new Error(`Ditto said ${res.status}: ${msg.slice(0, 200)}`);
  }
  return body;
}

type DeviceCode = { device_code: string; user_code: string; verification_url: string; verification_uri_complete?: string; expires_in: number; interval: number };

const deviceCode = (intent: "keys" | "login") =>
  dittoApi<DeviceCode>("/api/v2/mcp/device-code", { method: "POST", body: { client: "bitbull", intent, hostname: `BitBull on ${os.hostname()}`.slice(0, 128) } });

/** Start Ditto's sign-in; the UI shows the code and link, the server waits for approval. */
export async function startConnect(): Promise<ConnectState> {
  // with key access when Ditto offers it; a Ditto without the "keys" intent refuses it with a 400
  const code = await deviceCode("keys").catch((err) => {
    if (err instanceof Error && err.message.startsWith("Ditto said 400")) return deviceCode("login");
    throw err;
  });
  const url = code.verification_uri_complete || `${code.verification_url}${code.verification_url.includes("?") ? "&" : "?"}code=${encodeURIComponent(code.user_code)}`;
  const mine = ++attempt;
  state = { status: "waiting", userCode: code.user_code, url, expiresAt: Date.now() + (code.expires_in || 600) * 1000 };
  void waitForApproval(mine, code.device_code, Math.max(2, code.interval || 5)).catch((err) => {
    if (mine !== attempt) return;
    state = { status: "error", message: err instanceof Error ? err.message : String(err) };
    record({ level: "error", source: "ditto", message: `Connect Ditto failed: ${state.message}` });
  });
  return state;
}

async function waitForApproval(mine: number, deviceCode: string, intervalSec: number) {
  let interval = intervalSec * 1000;
  while (mine === attempt && state.status === "waiting" && Date.now() < state.expiresAt) {
    await new Promise((r) => setTimeout(r, interval));
    if (mine !== attempt) return;
    let res: { access_token?: string; error?: string };
    try {
      res = await dittoApi("/api/v2/mcp/device-token", {
        method: "POST",
        body: { device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      });
    } catch {
      continue; // a network blip or a 5xx: ask again next time, until the code expires
    }
    // a newer Connect replaced this one while the request was out: only the newest one sets keys
    if (mine !== attempt) return;
    if (res.access_token) {
      await provision(res.access_token);
      if (mine === attempt) state = { status: "connected", endpoint: CHAT_ENDPOINT };
      return;
    }
    if (res.error === "slow_down") interval += 5000;
    else if (res.error === "access_denied") throw new Error("Sign-in was declined in the browser.");
    else if (res.error !== "authorization_pending") throw new Error("The sign-in code expired. Start again.");
  }
  if (mine === attempt && state.status === "waiting") throw new Error("The sign-in code expired. Start again.");
}

type Endpoint = { id: string; slug: string };
type Key = { id: string; name?: string; revokedAt?: string | null };

const keyName = () => `BitBull on ${os.hostname()}`.slice(0, 100);

/** Create or reuse BitBull's two endpoints, mint a key for each, and make Ditto the default. */
async function provision(accountKey: string) {
  const { endpoints = [] } = await dittoApi<{ endpoints?: Endpoint[] }>("/api/v5/inference/endpoints", { key: accountKey });
  const keys: Record<string, string> = {};
  // keys an earlier Connect from this BitBull minted, revoked once the new ones are saved
  const replaced: Array<{ endpoint: string; key: string }> = [];
  for (const [slug, settings] of Object.entries(ENDPOINTS)) {
    let ep = endpoints.find((e) => e.slug === slug);
    // new endpoints use the account's own provider keys first, then Ditto credits; an existing
    // endpoint keeps the billing its owner chose
    if (!ep) ep = await dittoApi<Endpoint>("/api/v5/inference/endpoints", { method: "POST", key: accountKey, body: { slug, ...settings, billingMode: "both" } });
    else {
      if (slug === REVIEW_ENDPOINT) await dittoApi(`/api/v5/inference/endpoints/${encodeURIComponent(ep.id)}`, { method: "PATCH", key: accountKey, body: settings });
      const listed = await dittoApi<{ keys?: Key[] } | Key[]>(`/api/v5/inference/endpoints/${encodeURIComponent(ep.id)}/keys`, { key: accountKey }).catch(() => []);
      const old = Array.isArray(listed) ? listed : (listed.keys ?? []);
      for (const k of old) if (k.name === keyName() && !k.revokedAt) replaced.push({ endpoint: ep.id, key: k.id });
    }
    const minted = await dittoApi<{ key?: string }>(`/api/v5/inference/endpoints/${encodeURIComponent(ep.id)}/keys`, {
      method: "POST",
      key: accountKey,
      body: { name: keyName(), expiresIn: "never" },
    });
    if (!minted.key) throw new Error(`Ditto created a key for ${slug} but did not return it`);
    keys[slug] = minted.key;
  }
  await updateSettings({
    DITTO_API_KEY: accountKey,
    DITTO_ROUTER_KEY: keys[CHAT_ENDPOINT],
    DITTO_ROUTER_REVIEW_KEY: keys[REVIEW_ENDPOINT],
    // Ditto by default: the endpoint routes to its own model, and its background routes take titles
    // and compaction; SayGM models stay one pick away
    DEFAULT_MODEL: `${ROUTER_PREFIX}${CHAT_ENDPOINT}`,
    BACKGROUND_VIA: "ditto-router",
    DITTO_ROUTER_MODEL: CHAT_ENDPOINT,
  });
  for (const r of replaced) {
    await dittoApi(`/api/v5/inference/endpoints/${encodeURIComponent(r.endpoint)}/keys/${encodeURIComponent(r.key)}`, { method: "DELETE", key: accountKey }).catch((err) =>
      console.warn("[ditto] Couldn't revoke an old BitBull key:", err instanceof Error ? err.message : err),
    );
  }
  // the engines pick the new keys up before the next turn (a settings change restarts OpenCode)
  await Promise.all([routerModels(true).catch(() => []), routerMcpServers(true), routerReview(true)]);
  record({ level: "info", source: "ditto", message: `Connected to Ditto: endpoints ${CHAT_ENDPOINT} and ${REVIEW_ENDPOINT} (keys saved, values not logged)` });
}
