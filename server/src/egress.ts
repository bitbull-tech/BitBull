import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { record } from "./activity.js";
import { config, DATA_DIR, ROOT } from "./config.js";

/**
 * Network access on request.
 *
 * The sandbox reaches the internet only through the egress proxy. Domains in
 * egress/allowlist.txt are always allowed; anything else is refused unless the user
 * approved it here. Squid asks BitBull about every host that isn't on the static list
 * (external ACL helper → GET /internal/egress/check), so an approval takes effect within
 * seconds, with no redeploy or proxy restart, and BitBull also learns about every refusal.
 *
 * The agent asks with the `request_network_access` tool (BitBull's own MCP server, mcp.ts):
 * domain + why. The user sees a card with Allow / Allow the whole domain / Deny; the tool
 * call waits for that answer.
 *
 * Approvals live in memory only and end when BitBull restarts. They used to be saved in DATA_DIR,
 * but everything there is writable by the agent's shell (GAPS.md #11: same user as the
 * server), so a prompt-injected agent could have planted a domain that the next restart
 * would quietly allow. Domains needed for good belong in egress/allowlist.txt (in git,
 * reviewed, and outside the agent's reach).
 */

export type Scope = "host" | "domain";
export interface Approval {
  /** host (scope=host) or registrable domain (scope=domain: also every subdomain) */
  host: string;
  scope: Scope;
  approvedAt: string;
  reason?: string;
}
export type RequestStatus = "pending" | "approved" | "denied" | "expired";
export interface AccessRequest {
  id: string;
  host: string;
  /** suggested domain for "allow the whole domain" */
  domain: string;
  reason: string;
  sessionId?: string;
  sessionTitle?: string;
  status: RequestStatus;
  createdAt: string;
  decidedAt?: string;
  scope?: Scope;
}
export interface Blocked {
  host: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

const FILE = path.join(DATA_DIR, "egress-approved.json");
const WAIT_MS = Math.max(30, Number(process.env.NETWORK_REQUEST_TIMEOUT_S ?? 300)) * 1000;
/** a host the user just denied isn't asked about again for this long */
const DENY_MEMORY_MS = 10 * 60 * 1000;

let approved: Approval[] = [];
noteOldFile();
const requests: AccessRequest[] = [];
const waiters = new Map<string, Array<(r: AccessRequest) => void>>();
const blocked = new Map<string, Blocked>();
const listeners = new Set<() => void>();

/** The old on-disk list is never loaded; say what was in it, so nothing is lost silently. */
function noteOldFile() {
  try {
    if (!existsSync(FILE)) return;
    const v = JSON.parse(readFileSync(FILE, "utf8"));
    const hosts = Array.isArray(v) ? v.filter((a) => a && typeof a.host === "string" && validHost(a.host)).map((a) => (a.scope === "domain" ? `*.${a.host}` : a.host)) : [];
    if (hosts.length)
      setTimeout(
        () =>
          record({
            level: "warn",
            source: "network",
            message: `Approved domains no longer survive a restart; these were not restored: ${hosts.join(", ")}`,
            detail: `Approve them again when the agent asks, or add the ones you always need to egress/allowlist.txt and deploy. The old list (${FILE}) can be deleted.`,
          }),
        0,
      );
  } catch {
    /* unreadable: ignore */
  }
}
function save() {
  /* in memory only, by design (see the top of this file) */
}
function changed() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}
export function onNetworkChange(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Is BitBull behind the egress proxy at all? (host mode has open internet and no proxy) */
export const proxied = () => !!config.sandbox.egressProxy;

// ---------- hosts ----------

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export function validHost(h: string) {
  return HOST_RE.test(h);
}

/** "https://Foo.example.com:443/x" → "foo.example.com"; null if it isn't a plain DNS name. */
export function normalizeHost(input: string): string | null {
  let s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/^\./, "");
  s = s.split(/[/?#]/)[0].replace(/^[^@]*@/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return validHost(s) ? s : null;
}

// second-level labels under country codes that are registries, not owners (co.uk, com.au …)
const SLD = /^(co|com|org|net|gov|ac|edu|ltd|plc|me|sch|nhs|police|mod|nic|or|ne|go)\.[a-z]{2}$/;

/**
 * Suffixes anyone can get a name under. Without these, "allow the whole domain" for one
 * student.github.io would approve *every* GitHub Pages site — one click and the sandbox has an
 * exfiltration channel it can write to. Under these suffixes the registrable domain is the
 * suffix plus one label, so the approval covers that one site and nothing else.
 * Not the full Public Suffix List (no room for a 200kB list and a fetch the proxy would block):
 * the hosting, CDN and user-content suffixes an agent could plausibly reach.
 */
const PUBLIC_SUFFIXES = new Set([
  "github.io", "githubusercontent.com", "gitlab.io", "bitbucket.io", "sourceforge.io",
  "pages.dev", "workers.dev", "r2.dev", "cloudflareaccess.com", "trycloudflare.com",
  "vercel.app", "netlify.app", "netlify.com", "herokuapp.com", "onrender.com", "fly.dev",
  "railway.app", "deno.dev", "val.run", "glitch.me", "replit.dev", "repl.co", "codesandbox.io",
  "firebaseapp.com", "web.app", "appspot.com", "run.app", "cloudfunctions.net",
  "s3.amazonaws.com", "cloudfront.net", "elasticbeanstalk.com", "amplifyapp.com", "awsapprunner.com",
  "blob.core.windows.net", "azurewebsites.net", "azureedge.net", "azurestaticapps.net",
  "ngrok.io", "ngrok-free.app", "ngrok.app", "loca.lt", "serveo.net", "tunnelto.dev",
  "surge.sh", "neocities.org", "gitbook.io", "notion.site", "webflow.io", "wixsite.com",
  "blogspot.com", "wordpress.com", "tumblr.com", "myshopify.com", "squarespace.com",
  "sharepoint.com", "googleusercontent.com", "googleapis.com", "discordapp.net", "discord.com",
  "ipfs.io", "dweb.link", "pastebin.com", "gist.github.com", "requestbin.net", "webhook.site",
  "pipedream.net", "beeceptor.com", "oast.fun", "interact.sh", "burpcollaborator.net",
]);

/**
 * The registrable domain a "whole domain" approval would cover: the public suffix plus one
 * label. Under a suffix anyone can register beneath, that is the single site, not the suffix.
 */
export function domainOf(host: string) {
  const parts = host.split(".");
  for (let i = 1; i < parts.length; i++) {
    if (PUBLIC_SUFFIXES.has(parts.slice(i).join("."))) return parts.slice(Math.max(0, i - 1)).join(".");
  }
  const n = parts.length >= 3 && SLD.test(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** True when the host sits under a suffix anyone can register beneath (shown in the approval UI). */
export function onSharedSuffix(host: string) {
  const parts = host.split(".");
  for (let i = 1; i < parts.length; i++) if (PUBLIC_SUFFIXES.has(parts.slice(i).join("."))) return true;
  return false;
}

/** Thrown when a "whole domain" approval would cover a suffix itself rather than one owner's site. */
export class ScopeRefused extends Error {}

/** A bare suffix name (github.io, co.uk): a domain approval here covers every tenant, not one owner. */
function isBareSuffix(target: string) {
  return PUBLIC_SUFFIXES.has(target) || SLD.test(target);
}

/** The static list the proxy always allows (egress/allowlist.txt, baked into the image). */
export function staticAllowlist(): string[] {
  const f = path.join(ROOT, "egress", "allowlist.txt");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim().toLowerCase())
    .filter(Boolean);
}
function onStatic(host: string) {
  return staticAllowlist().some((e) => (e.startsWith(".") ? host === e.slice(1) || host.endsWith(e) : host === e));
}
export function isApproved(host: string) {
  return approved.some((a) => (a.scope === "domain" ? host === a.host || host.endsWith(`.${a.host}`) : host === a.host));
}

// ---------- the proxy's question ----------

let egressIps: { at: number; ips: string[] } = { at: 0, ips: [] };
/** Only the egress container may ask (it is the one place a refusal is enforced). */
export async function fromEgress(remote: string | undefined) {
  if (!proxied() || !remote) return false;
  const ip = remote.replace(/^::ffff:/, "");
  const refresh = async () => {
    try {
      const host = new URL(config.sandbox.egressProxy).hostname;
      egressIps = { at: Date.now(), ips: (await lookup(host, { all: true })).map((a) => a.address) };
    } catch {
      egressIps = { at: Date.now(), ips: [] };
    }
  };
  if (Date.now() - egressIps.at > 60_000 || !egressIps.ips.length) await refresh();
  // an unknown caller may be the proxy with a new address (recreated on deploy): look again,
  // at most once every few seconds so a stranger can't make this a DNS hammer
  if (!egressIps.ips.includes(ip) && Date.now() - egressIps.at > 3_000) await refresh();
  return egressIps.ips.includes(ip);
}

/** Squid asks: may this host (not on the static list) be reached? Refusals are remembered. */
export function proxyCheck(rawHost: string): boolean {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  if (isApproved(host)) return true;
  const now = new Date().toISOString();
  const b = blocked.get(host);
  if (b) {
    b.count++;
    b.lastAt = now;
  } else {
    blocked.set(host, { host, count: 1, firstAt: now, lastAt: now });
    if (blocked.size > 200) blocked.delete(blocked.keys().next().value!);
    record({ level: "warn", source: "network", message: `Blocked ${host}: not on the allowlist`, detail: "Allow it in Settings → Network, or the agent can ask with request_network_access." });
    changed();
  }
  return false;
}

// ---------- requests from the agent ----------

export function listRequests() {
  return requests.slice(-50);
}

export async function requestAccess(input: { domain: string; reason: string; sessionId?: string; sessionTitle?: string }): Promise<{ ok: boolean; text: string }> {
  const host = normalizeHost(input.domain);
  if (!proxied()) return { ok: true, text: "There is no egress proxy in this environment, so nothing needs approving. If the request still fails, the cause is something else." };
  if (!host) return { ok: false, text: `"${input.domain}" isn't a domain name. Ask for a host such as api.example.com (no IP addresses, ports or paths).` };
  const reason = String(input.reason ?? "").trim().slice(0, 600);
  if (!reason) return { ok: false, text: "Give a reason: one sentence the user can judge, saying what you need from this domain and why." };
  if (onStatic(host) || isApproved(host)) {
    return {
      ok: true,
      text: `${host} is already allowed. If requests to it still fail, they may be redirected to another domain (request that one), or the problem is elsewhere.`,
    };
  }
  const denied = [...requests].reverse().find((r) => r.host === host && r.status === "denied");
  if (denied && Date.now() - Date.parse(denied.decidedAt!) < DENY_MEMORY_MS) {
    return { ok: false, text: `The user denied access to ${host} a few minutes ago. Don't ask again; carry on without it or tell the user what you can't do.` };
  }
  let req = requests.find((r) => r.host === host && r.status === "pending");
  if (!req) {
    req = {
      id: randomUUID(),
      host,
      domain: domainOf(host),
      reason,
      sessionId: input.sessionId,
      sessionTitle: input.sessionTitle,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    requests.push(req);
    if (requests.length > 200) requests.splice(0, requests.length - 200);
    record({
      level: "warn",
      source: "network",
      message: `Agent asks to reach ${host}`,
      detail: reason,
      ...(input.sessionId ? { sessionId: input.sessionId, sessionTitle: input.sessionTitle } : {}),
    });
    changed();
  }
  const r = req;
  const decided = await new Promise<AccessRequest | null>((resolve) => {
    const list = waiters.get(r.id) ?? [];
    const done = (x: AccessRequest) => {
      clearTimeout(t);
      resolve(x);
    };
    list.push(done);
    waiters.set(r.id, list);
    const t = setTimeout(() => {
      const l = waiters.get(r.id);
      if (l) waiters.set(r.id, l.filter((f) => f !== done));
      resolve(null);
    }, WAIT_MS);
  });
  if (!decided) {
    return {
      ok: false,
      text: `No answer from the user within ${Math.round(WAIT_MS / 60000)} minutes. The request for ${host} is still waiting in their Network panel. Tell the user you need it and why, and carry on with anything that doesn't depend on it.`,
    };
  }
  if (decided.status === "approved") {
    const what = decided.scope === "domain" ? `${decided.domain} and all its subdomains` : host;
    return { ok: true, text: `Approved: ${what} can be reached now (give it a few seconds to take effect). Retry the request.` };
  }
  return { ok: false, text: `The user denied access to ${host}. Don't try to reach it another way; carry on without it or explain what you can't do.` };
}

/** The user's answer to a pending request. */
export function decide(id: string, decision: "host" | "domain" | "deny"): AccessRequest | null {
  const r = requests.find((x) => x.id === id);
  if (!r) return null;
  if (r.status !== "pending") return r;
  r.decidedAt = new Date().toISOString();
  if (decision === "deny") r.status = "denied";
  else {
    if (decision === "domain" && isBareSuffix(r.domain)) {
      throw new ScopeRefused(`${r.domain} is a suffix anyone can register under, not one owner's domain — allow the host ${r.host} instead.`);
    }
    r.status = "approved";
    r.scope = decision;
    addApproval(decision === "domain" ? r.domain : r.host, decision, r.reason);
  }
  record({
    level: "info",
    source: "network",
    message: r.status === "approved" ? `Allowed ${decision === "domain" ? `*.${r.domain}` : r.host}` : `Denied ${r.host}`,
    ...(r.sessionId ? { sessionId: r.sessionId, sessionTitle: r.sessionTitle } : {}),
  });
  for (const fn of waiters.get(id) ?? []) fn(r);
  waiters.delete(id);
  changed();
  return r;
}

/** Allow a host or whole domain directly (Settings → Network, or from the blocked list). */
export function addApproval(rawHost: string, scope: Scope, reason?: string): Approval | null {
  const host = normalizeHost(rawHost);
  if (!host) return null;
  const target = scope === "domain" ? domainOf(host) : host;
  if (scope === "domain" && isBareSuffix(target)) {
    throw new ScopeRefused(`${target} is a suffix anyone can register under, not one owner's domain — allow individual hosts instead.`);
  }
  approved = approved.filter((a) => !(a.host === target && a.scope === scope));
  const a: Approval = { host: target, scope, approvedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
  approved.push(a);
  save();
  // anything now covered stops showing as blocked; matching pending requests are answered
  for (const h of [...blocked.keys()]) if (isApproved(h)) blocked.delete(h);
  for (const r of requests) {
    if (r.status === "pending" && isApproved(r.host)) {
      r.status = "approved";
      r.scope = scope;
      r.decidedAt = a.approvedAt;
      for (const fn of waiters.get(r.id) ?? []) fn(r);
      waiters.delete(r.id);
    }
  }
  changed();
  return a;
}

export function revoke(host: string, scope?: Scope) {
  const before = approved.length;
  approved = approved.filter((a) => !(a.host === host && (!scope || a.scope === scope)));
  if (approved.length === before) return false;
  save();
  record({ level: "info", source: "network", message: `Removed ${scope === "domain" ? `*.${host}` : host} from approved domains` });
  changed();
  return true;
}

/** Expire requests nobody is waiting on any more (the agent's tool call timed out). */
function sweep() {
  for (const r of requests) {
    if (r.status === "pending" && !waiters.get(r.id)?.length && Date.now() - Date.parse(r.createdAt) > WAIT_MS + 5000) {
      r.status = "expired";
      r.decidedAt = new Date().toISOString();
    }
  }
}

export function networkState() {
  sweep();
  return {
    proxied: proxied(),
    allowlist: staticAllowlist(),
    approved,
    requests: listRequests(),
    blocked: [...blocked.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 50),
  };
}

/** test hook */
export function _reset() {
  approved = [];
  requests.length = 0;
  waiters.clear();
  blocked.clear();
}
