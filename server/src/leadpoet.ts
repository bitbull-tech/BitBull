/**
 * Leadpoet (Bittensor subnet 71): B2B lead sourcing and outreach, through Leadpoet's own MCP
 * server (https://leadpoet.com/mcp). With it the agent can plan and run a lead-generation
 * campaign: define the ideal customer, request leads, review the pipeline, write email and
 * LinkedIn sequences and, only if the owner allowed sending, launch them.
 *
 * Sign-in, not a key. Leadpoet's MCP server uses OAuth (authorization code + PKCE, dynamic
 * client registration), the same flow Claude, ChatGPT and Cursor use to connect to it. The owner
 * presses Connect in Settings, approves in Leadpoet, and comes back to BitBull's callback.
 *
 * What the owner decides at connect time, enforced by Leadpoet on every call (scopes):
 *   read   look only: credits, requests, pipeline, campaigns
 *   edit   also create lead requests (these spend credits), update the pipeline, write campaigns
 *   send   also send email and LinkedIn messages and launch campaigns. Off unless asked for.
 *
 * The agent never holds the tokens. The engines are given a local address on BitBull
 * (/mcp/leadpoet, behind the same startup token as BitBull's own MCP server); BitBull adds the
 * access token there and forwards to Leadpoet, refreshing it when it is about to expire. Every
 * tool call is written to Activity by name, so there is a record of what was asked of Leadpoet.
 *
 * Tokens are saved like a key typed into Settings (the vault when it is unlocked). Where they
 * are sent (LEADPOET_URL) is .env-only, and every OAuth address Leadpoet advertises must be on
 * that same origin, so nothing read back from the data folder or from the network can redirect them.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { record } from "./activity.js";
import { config } from "./config.js";
import { addBuiltIn } from "./egress.js";
import { updateSettings } from "./settings.js";

export type Access = "read" | "edit";
const READ = ["credits:read", "lead_engine:read", "pipeline:read", "outreach:read"];
const WRITE = ["lead_engine:write", "pipeline:write", "outreach:write"];
const SEND = "outreach:send";

export const scopesFor = (access: Access, send: boolean) => [...READ, ...(access === "edit" ? WRITE : []), ...(access === "edit" && send ? [SEND] : [])];

const base = () => config.integrations.leadpoet.url;
const origin = () => new URL(base()).origin;
export const leadpoetMcpUrl = () => `${base()}/mcp`;

// ---------- what is saved ----------

interface Saved {
  clientId: string;
  redirect: string;
  access: string;
  refresh: string;
  /** ms since epoch; 0 when Leadpoet gave no lifetime */
  expiresAt: number;
  scope: string;
  connectedAt: number;
}

function saved(): Saved | null {
  const raw = config.integrations.leadpoet.oauth;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Saved>;
    if (typeof s.access !== "string" || !s.access || typeof s.clientId !== "string") return null;
    return {
      clientId: s.clientId,
      redirect: typeof s.redirect === "string" ? s.redirect : "",
      access: s.access,
      refresh: typeof s.refresh === "string" ? s.refresh : "",
      expiresAt: Number.isFinite(s.expiresAt) ? (s.expiresAt as number) : 0,
      scope: typeof s.scope === "string" ? s.scope : "",
      connectedAt: Number.isFinite(s.connectedAt) ? (s.connectedAt as number) : 0,
    };
  } catch {
    return null;
  }
}

const save = (s: Saved | null) => updateSettings({ LEADPOET_OAUTH: s ? JSON.stringify(s) : null }, { internal: true });

export const leadpoetConnected = () => !!saved();

// ---------- talking to Leadpoet's OAuth server ----------

interface Meta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

/** An address Leadpoet advertises is only used if it is on Leadpoet's own origin. */
function onOrigin(url: unknown, what: string): string {
  if (typeof url !== "string") throw new Error(`Leadpoet's sign-in details have no ${what}`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Leadpoet's ${what} isn't an address`);
  }
  if (u.origin !== origin()) throw new Error(`Leadpoet's ${what} points somewhere else (${u.host}); not using it`);
  return u.toString();
}

async function call(url: string, init: RequestInit, tries = 2): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: "error" });
    } catch (e) {
      // the proxy opens Leadpoet's host a moment after a sign-in starts: one more go
      if (i + 1 >= tries) throw new Error(`Couldn't reach Leadpoet (${e instanceof Error ? e.message : String(e)})`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function discover(): Promise<Meta> {
  const res = await call(`${origin()}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Leadpoet's sign-in details aren't available (${res.status})`);
  const m = (await res.json()) as Record<string, unknown>;
  return {
    authorization_endpoint: onOrigin(m.authorization_endpoint, "authorization address"),
    token_endpoint: onOrigin(m.token_endpoint, "token address"),
    registration_endpoint: m.registration_endpoint ? onOrigin(m.registration_endpoint, "registration address") : undefined,
  };
}

async function register(meta: Meta, redirect: string): Promise<string> {
  if (!meta.registration_endpoint) throw new Error("Leadpoet doesn't let apps register themselves any more; BitBull needs an update for this.");
  const res = await call(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "BitBull",
      client_uri: "https://www.bitbull.tech",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { client_id?: string; error_description?: string; error?: string };
  if (!res.ok || !j.client_id) throw new Error(`Leadpoet didn't register BitBull (${j.error_description ?? j.error ?? res.status})`);
  return j.client_id;
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function token(meta: Meta, params: Record<string, string>): Promise<TokenReply & { status: number }> {
  const res = await call(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...params, resource: leadpoetMcpUrl() }).toString(),
  });
  return { ...((await res.json().catch(() => ({}))) as TokenReply), status: res.status };
}

// ---------- connecting ----------

const b64url = (b: Buffer) => b.toString("base64url");

interface Pending {
  state: string;
  verifier: string;
  redirect: string;
  clientId: string;
  meta: Meta;
  scope: string;
  expiresAt: number;
  url: string;
}
let pending: Pending | null = null;
let lastError = "";
/** While a sign-in is under way the proxy has to let Leadpoet through, before anything is saved. */
const PENDING_MS = 10 * 60_000;
const livePending = () => {
  if (pending && Date.now() > pending.expiresAt) pending = null;
  return pending;
};

let openUntil = 0;
addBuiltIn(() => (leadpoetConnected() || livePending() || Date.now() < openUntil ? [{ host: new URL(base()).hostname.toLowerCase(), why: "Leadpoet" }] : []));

/**
 * Where Leadpoet sends the browser back to. It must be this BitBull as the owner's browser
 * reaches it: this computer (loopback), or an https address. Anything else is refused, so a
 * sign-in can't be pointed at someone else's server.
 */
export function redirectFor(appOrigin: string): string {
  let u: URL;
  try {
    u = new URL(appOrigin);
  } catch {
    throw new Error("BitBull couldn't tell its own address; open it in a browser and try again.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (!(u.protocol === "https:" || (u.protocol === "http:" && loopback))) throw new Error("Connect Leadpoet from BitBull on this computer (127.0.0.1) or over https.");
  return `${u.origin}/oauth/leadpoet/callback`;
}

/** Start a sign-in: returns the Leadpoet address to open. */
export async function startConnect(input: { origin: string; access?: Access; send?: boolean }) {
  const redirect = redirectFor(input.origin);
  const scope = scopesFor(input.access ?? "edit", !!input.send).join(" ");
  lastError = "";
  openUntil = Date.now() + PENDING_MS;
  try {
    const meta = await discover();
    // one registration per address BitBull is reached at; reused on reconnect
    const prev = saved();
    const clientId = prev && prev.redirect === redirect && prev.clientId ? prev.clientId : await register(meta, redirect);
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(24));
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope,
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      resource: leadpoetMcpUrl(),
    });
    const url = `${meta.authorization_endpoint}${meta.authorization_endpoint.includes("?") ? "&" : "?"}${q}`;
    pending = { state, verifier, redirect, clientId, meta, scope, expiresAt: Date.now() + PENDING_MS, url };
    return leadpoetState();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Finish a sign-in with what Leadpoet sent back. Called by the callback page, or with the
 * address pasted by hand when the browser couldn't reach BitBull.
 */
export async function finishConnect(params: { code?: string | null; state?: string | null; error?: string | null; errorDescription?: string | null }) {
  const p = livePending();
  if (!p || !params.state || !sameText(params.state, p.state)) throw new Error("That sign-in isn't the one BitBull started, or it ran out of time. Press Connect again.");
  pending = null; // one use, whatever happens next
  try {
    if (params.error) throw new Error(params.error === "access_denied" ? "You declined in Leadpoet. Nothing was connected." : `Leadpoet said: ${(params.errorDescription || params.error).slice(0, 200)}`);
    if (!params.code) throw new Error("Leadpoet sent no sign-in code back.");
    const t = await token(p.meta, { grant_type: "authorization_code", code: params.code, redirect_uri: p.redirect, client_id: p.clientId, code_verifier: p.verifier });
    if (!t.access_token) throw new Error(`Leadpoet didn't complete the sign-in (${(t.error_description ?? t.error ?? String(t.status)).slice(0, 200)})`);
    const scope = typeof t.scope === "string" && t.scope ? t.scope : p.scope;
    await save({
      clientId: p.clientId,
      redirect: p.redirect,
      access: t.access_token,
      refresh: t.refresh_token ?? "",
      expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : 0,
      scope,
      connectedAt: Date.now(),
    });
    lastError = "";
    const sends = scope.split(/\s+/).includes(SEND);
    record({ level: sends ? "warn" : "info", source: "integration", message: `Leadpoet connected (${describeScope(scope)})`, detail: sends ? "Sending is allowed: the agent can send email and LinkedIn messages and launch campaigns through Leadpoet." : undefined });
    return leadpoetState();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}

/** The address the browser landed on, pasted in by hand. */
export async function finishFromUrl(pasted: string) {
  let u: URL;
  try {
    u = new URL(pasted.trim());
  } catch {
    throw new Error("Paste the whole address from the browser's address bar (it starts with http).");
  }
  const q = u.searchParams;
  return finishConnect({ code: q.get("code"), state: q.get("state"), error: q.get("error"), errorDescription: q.get("error_description") });
}

export async function disconnect() {
  pending = null;
  openUntil = 0;
  lastError = "";
  if (saved()) {
    await save(null);
    record({ level: "info", source: "integration", message: "Leadpoet disconnected here. To end the connection on Leadpoet's side too: Settings → Integrations → AI assistants in Leadpoet." });
  }
  return leadpoetState();
}

// ---------- a token that works ----------

let refreshing: Promise<string | null> | null = null;

/** The access token, refreshed first if it is about to run out. null: not connected (any more). */
export async function accessToken(force = false): Promise<string | null> {
  const s = saved();
  if (!s) return null;
  const fresh = !s.expiresAt || s.expiresAt - Date.now() > 60_000;
  if (fresh && !force) return s.access;
  if (!s.refresh) return force ? null : s.access; // nothing to refresh with: let Leadpoet say no
  refreshing ??= (async () => {
    try {
      const meta = await discover();
      const t = await token(meta, { grant_type: "refresh_token", refresh_token: s.refresh, client_id: s.clientId });
      if (!t.access_token) {
        // refused for good (revoked in Leadpoet, or the refresh token expired): sign in again
        if (t.status === 400 || t.status === 401) {
          await save(null);
          lastError = "Leadpoet ended this connection (revoked or expired). Connect again.";
          record({ level: "warn", source: "integration", message: lastError });
          return null;
        }
        throw new Error(t.error_description ?? t.error ?? `HTTP ${t.status}`);
      }
      await save({ ...s, access: t.access_token, refresh: t.refresh_token ?? s.refresh, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : 0, scope: t.scope || s.scope });
      return t.access_token;
    } catch (e) {
      record({ level: "warn", source: "integration", message: `Couldn't renew the Leadpoet sign-in: ${e instanceof Error ? e.message : String(e)}` });
      return force ? null : s.access;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- what Settings shows ----------

function describeScope(scope: string) {
  const s = new Set(scope.split(/\s+/));
  const edit = WRITE.some((w) => s.has(w));
  return `${edit ? "read and edit" : "read only"}${s.has(SEND) ? ", sending allowed" : ", no sending"}`;
}

/** Never includes a token. */
export function leadpoetState() {
  const s = saved();
  const p = livePending();
  const scopes = new Set((s?.scope ?? "").split(/\s+/).filter(Boolean));
  return {
    connected: !!s,
    access: s ? ((WRITE.some((w) => scopes.has(w)) ? "edit" : "read") as Access) : null,
    send: scopes.has(SEND),
    connectedAt: s?.connectedAt ?? null,
    /** a sign-in waiting for the owner to approve in Leadpoet */
    pending: p ? { url: p.url, redirect: p.redirect, expiresAt: p.expiresAt } : null,
    error: lastError,
    manageUrl: `${origin()}/auth`,
  };
}

// ---------- the engines' way in ----------

const FORWARD = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const RETURN = ["content-type", "mcp-session-id", "cache-control", "www-authenticate"];

/** Tool calls, by name only, for the Activity log. */
function logCalls(body: string) {
  try {
    const j = JSON.parse(body) as unknown;
    for (const m of Array.isArray(j) ? j : [j]) {
      const r = m as { method?: string; params?: { name?: unknown } };
      if (r?.method === "tools/call" && typeof r.params?.name === "string") record({ level: "info", source: "integration", message: `Leadpoet: ${r.params.name.slice(0, 80)}` });
    }
  } catch {
    /* not JSON: nothing to log */
  }
}

/**
 * Forward one MCP request from an engine to Leadpoet with the access token added. The caller
 * has already checked BitBull's internal token. A 401 from Leadpoet gets one retry with a
 * renewed token.
 */
export async function proxyMcp(req: Request): Promise<Response> {
  let tok = await accessToken();
  if (!tok) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Leadpoet isn't connected. The owner connects it in BitBull: Settings → Integrations → Leadpoet." } }, { status: 401 });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  if (body) logCalls(body);
  const send = (t: string) => {
    const headers = new Headers();
    for (const h of FORWARD) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("authorization", `Bearer ${t}`);
    return fetch(leadpoetMcpUrl(), { method: req.method, headers, body, redirect: "error", signal: req.signal });
  };
  let res: Response;
  try {
    res = await send(tok);
    if (res.status === 401) {
      tok = await accessToken(true);
      if (tok) {
        await res.body?.cancel().catch(() => {});
        res = await send(tok);
      }
    }
  } catch (e) {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32002, message: `Couldn't reach Leadpoet (${e instanceof Error ? e.message : String(e)})` } }, { status: 502 });
  }
  const headers = new Headers();
  for (const h of RETURN) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

/** For tests. */
export function _resetLeadpoet() {
  pending = null;
  openUntil = 0;
  lastError = "";
  refreshing = null;
}
export const _pendingState = () => livePending()?.state;
