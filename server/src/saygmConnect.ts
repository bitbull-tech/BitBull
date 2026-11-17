/**
 * Connect with SayGM: the owner signs in (or signs up) on saygm.com and BitBull receives a key
 * of its own for their account. No key is copied or pasted.
 *
 * This is SayGM's partner sign-in (docs.saygm.com/api/oauth): Authorization Code with PKCE and a
 * public client id, no client secret. BitBull is one registered app with exact loopback callback
 * addresses, which is why Connect only works from BitBull on the computer it runs on.
 *
 * What comes back, and where it goes:
 *   - `inference_api_key`: a key dedicated to BitBull, spending the owner's SayGM credits within
 *     the monthly limit they chose on SayGM's consent page. Saved as SAYGM_API_KEY, exactly where
 *     a pasted key would be, so everything else in BitBull is unchanged. It is given once, at the
 *     exchange; a refresh never returns it.
 *   - an access and a refresh token for SayGM's account API (the profile, and revoking). Saved as
 *     SAYGM_OAUTH. Both are secrets: vault, redaction and the engines' environment treat them
 *     like any key.
 *
 * The referral code rides on the browser address only (`ref=`): SayGM credits an account that is
 * created through that sign-in. It is not a credential and nothing about the owner is sent with it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { updateSettings } from "./settings.js";
import { record } from "./activity.js";

export const SAYGM_CALLBACK = "/oauth/saygm/callback";
/** Asked for together, up front: SayGM makes every user reconnect if an app's permissions change later. */
export const SAYGM_SCOPES = ["inference:use", "usage:read", "profile:read"];
/** The callback addresses registered with SayGM for the BitBull app. They are matched exactly, port and path included. */
export const REGISTERED_ORIGINS = ["http://127.0.0.1:8787", "http://localhost:8787", "http://127.0.0.1:8788", "http://localhost:8788"];
const PENDING_MS = 10 * 60_000;

interface Saved {
  access: string;
  refresh: string;
  expiresAt: number;
  scope: string;
  /** the SayGM account, as its profile gave it; shown so the owner can see which account is connected */
  email: string;
  connectedAt: number;
}

function saved(): Saved | null {
  const raw = config.saygm.oauth;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Saved>;
    if (typeof s.refresh !== "string" || !s.refresh) return null;
    return {
      access: typeof s.access === "string" ? s.access : "",
      refresh: s.refresh,
      expiresAt: Number.isFinite(s.expiresAt) ? (s.expiresAt as number) : 0,
      scope: typeof s.scope === "string" ? s.scope : "",
      email: typeof s.email === "string" ? s.email.slice(0, 200) : "",
      connectedAt: Number.isFinite(s.connectedAt) ? (s.connectedAt as number) : 0,
    };
  } catch {
    return null;
  }
}

let pending: { state: string; verifier: string; redirect: string; url: string; expiresAt: number } | null = null;
let lastError = "";

export interface SaygmConnectState {
  /** BitBull has a client id, so Connect can be offered at all */
  available: boolean;
  /** connected through Connect (a key pasted by hand is "not connected" here, and still works) */
  connected: boolean;
  email: string;
  scopes: string[];
  connectedAt: number | null;
  pending: { url: string; redirect: string; expiresAt: number } | null;
  error: string;
  /** where the owner changes the spending limit or revokes BitBull on SayGM's side */
  manageUrl: string;
  /** for links BitBull shows to someone who has no SayGM account yet */
  signupUrl: string;
}

export const signupUrl = () => (config.saygm.ref ? `https://saygm.com/r/${encodeURIComponent(config.saygm.ref)}` : "https://saygm.com");

export function saygmConnectState(): SaygmConnectState {
  if (pending && pending.expiresAt < Date.now()) pending = null;
  const s = saved();
  return {
    available: !!config.saygm.oauthClientId,
    connected: !!s && !!config.saygm.apiKey,
    email: s?.email ?? "",
    scopes: s ? s.scope.split(/\s+/).filter(Boolean) : [],
    connectedAt: s?.connectedAt || null,
    pending: pending ? { url: pending.url, redirect: pending.redirect, expiresAt: pending.expiresAt } : null,
    error: lastError,
    manageUrl: "https://saygm.com/login",
    signupUrl: signupUrl(),
  };
}

/**
 * Where SayGM sends the browser back to. SayGM matches the callback exactly against the ones
 * registered for BitBull, so it has to be BitBull on this computer at one of its usual ports.
 */
export function redirectFor(appOrigin: string): string {
  let u: URL;
  try {
    u = new URL(appOrigin);
  } catch {
    throw new Error("BitBull couldn't tell its own address; open it in a browser and try again.");
  }
  if (!REGISTERED_ORIGINS.includes(u.origin))
    throw new Error(`Connect with SayGM works from BitBull on the computer it runs on (http://127.0.0.1:8787). This page is at ${u.origin}, which SayGM doesn't know as a BitBull address. Open BitBull there, or paste a SayGM key instead.`);
  return `${u.origin}${SAYGM_CALLBACK}`;
}

/** Start a sign-in: returns the saygm.com address to open in the owner's browser. */
export function startConnect(input: { origin: string }): SaygmConnectState {
  const clientId = config.saygm.oauthClientId;
  if (!clientId) throw new Error("Connect with SayGM isn't set up in this BitBull yet (no client id). Paste a SayGM key instead.");
  const redirect = redirectFor(input.origin);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const url = new URL(config.saygm.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: SAYGM_SCOPES.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(config.saygm.ref ? { ref: config.saygm.ref } : {}),
  }).toString();
  pending = { state, verifier, redirect, url: url.toString(), expiresAt: Date.now() + PENDING_MS };
  lastError = "";
  return saygmConnectState();
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function account(pathname: string, init: { method?: string; body?: unknown; bearer?: string } = {}, f: typeof fetch = fetch): Promise<Response> {
  return f(`${config.saygm.accountUrl}${pathname}`, {
    method: init.method ?? "GET",
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    // SayGM's guidance: never follow a redirect with credentials in the request
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
}

/**
 * The browser came back. Check it is the sign-in BitBull started, swap the code for the key and
 * tokens, and save them. Throws with a sentence the callback page can show.
 */
export async function finishConnect(q: { code: string | null; state: string | null; error: string | null }, f: typeof fetch = fetch): Promise<SaygmConnectState> {
  const p = pending;
  if (!p || p.expiresAt < Date.now()) {
    pending = null;
    throw new Error("There is no SayGM sign-in waiting (it may have timed out). Start again from BitBull.");
  }
  if (!q.state || !same(q.state, p.state)) throw new Error("This doesn't match the sign-in BitBull started. Start again from BitBull.");
  // one go per sign-in, whatever happens next
  pending = null;
  const fail = (msg: string) => {
    lastError = msg;
    return new Error(msg);
  };
  if (q.error) throw fail(q.error === "access_denied" ? "You chose not to connect BitBull on SayGM. Nothing was changed." : `SayGM didn't complete the sign-in (${q.error.slice(0, 80)}).`);
  if (!q.code) throw fail("SayGM sent no sign-in code. Start again from BitBull.");

  let res: Response;
  try {
    res = await account("/oauth/token", { method: "POST", body: { grant_type: "authorization_code", client_id: config.saygm.oauthClientId, code: q.code, redirect_uri: p.redirect, code_verifier: p.verifier } }, f);
  } catch (e) {
    throw fail(`Couldn't reach SayGM to finish the sign-in (${e instanceof Error ? e.message : String(e)}). Start again from BitBull.`);
  }
  if (!res.ok) {
    let why = "";
    try {
      const j = (await res.json()) as { error?: unknown; error_description?: unknown };
      why = [j.error, j.error_description].filter((x) => typeof x === "string").join(": ").slice(0, 160);
    } catch {
      /* not JSON */
    }
    throw fail(`SayGM refused the sign-in (${res.status}${why ? `, ${why}` : ""}). Start again from BitBull.`);
  }
  const t = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const key = str(t.inference_api_key);
  const scope = str(t.scope);
  if (!key) {
    // connected, but with nothing BitBull can run models on: take it back rather than leave a half-connection on SayGM
    if (str(t.refresh_token)) await account("/oauth/revoke", { method: "POST", body: { token: str(t.refresh_token) } }, f).catch(() => {});
    throw fail("SayGM connected BitBull without a key for models, because \"use models\" wasn't allowed on its consent page. BitBull can't work without it: start again and leave that permission on.");
  }
  if (/\s/.test(key) || key.length < 12 || key.length > 400) throw fail("SayGM sent a key BitBull can't use. Start again, or paste a key by hand.");

  // which account this is, when the owner allowed BitBull to see it
  let email = "";
  if (scope.split(/\s+/).includes("profile:read") && str(t.access_token)) {
    try {
      const me = await account("/me", { bearer: str(t.access_token) }, f);
      if (me.ok) {
        const j = (await me.json()) as { email?: unknown; user?: { email?: unknown } };
        email = str(j.email) || str(j.user?.email);
      }
    } catch {
      /* the connection stands without a name on it */
    }
  }
  const s: Saved = {
    access: str(t.access_token),
    refresh: str(t.refresh_token),
    expiresAt: Date.now() + (typeof t.expires_in === "number" && t.expires_in > 0 ? t.expires_in : 0) * 1000,
    scope,
    email: email.replace(/[\u0000-\u001f]/g, "").slice(0, 200),
    connectedAt: Date.now(),
  };
  await updateSettings({ SAYGM_API_KEY: key, SAYGM_OAUTH: JSON.stringify(s) }, { internal: true });
  lastError = "";
  record({ level: "info", source: "integration", message: `SayGM connected${s.email ? ` as ${s.email}` : ""}: BitBull has its own key on that account (${scope || "no permissions listed"})` });
  return saygmConnectState();
}

/**
 * Disconnect: revoke BitBull on SayGM (which also disables its key), then forget the key and
 * tokens here. If SayGM can't be reached the local copy is still removed, and that is said.
 */
export async function disconnect(f: typeof fetch = fetch): Promise<SaygmConnectState & { note?: string }> {
  const s = saved();
  pending = null;
  let note: string | undefined;
  if (s) {
    try {
      const r = await account("/oauth/revoke", { method: "POST", body: { token: s.refresh } }, f);
      if (!r.ok) note = `SayGM answered ${r.status} to the revoke, so BitBull may still be listed there: remove it under Connected apps on saygm.com.`;
    } catch {
      note = "SayGM couldn't be reached to revoke BitBull there: remove it under Connected apps on saygm.com.";
    }
    await updateSettings({ SAYGM_API_KEY: null, SAYGM_OAUTH: null }, { internal: true });
    record({ level: note ? "warn" : "info", source: "integration", message: `SayGM disconnected${note ? `. ${note}` : ""}` });
  }
  lastError = "";
  return { ...saygmConnectState(), note };
}

/** Tests only. */
export function _resetSaygmConnect() {
  pending = null;
  lastError = "";
}
