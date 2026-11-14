/**
 * What is left to spend, shown in Usage without signing in anywhere: the keys BitBull already
 * holds can read it.
 *
 *  - SayGM: GET /v1/credits with the API key returns the key's spendable balance.
 *  - Ditto Router: the account key (set by Connect Ditto) can read the "bitbull" endpoint's usage:
 *    what it spent in the last 30 days and, if the endpoint has a spend cap, what is left under
 *    it. Ditto has no documented "account credit balance" call, so that is not shown.
 *
 * Neither answer's exact shape is pinned in public docs, so both are read tolerantly: an amount
 * is taken only from a field whose name says what it is (balance, remaining, spend…) and in what
 * unit, and anything unrecognised is shown as "not available" rather than guessed. The field
 * names of an answer that couldn't be read go to Activity once (names only, never values).
 * Read-only, cached for a minute, never sent to the agent.
 */
import { record } from "./activity.js";
import { config } from "./config.js";

export interface Balance {
  /** is there a key to ask with */
  configured: boolean;
  ok: boolean;
  /** USD */
  amount?: number;
  /** why there is no amount */
  note?: string;
}
export interface Balances {
  saygm: Balance;
  ditto: Balance & { spent30d?: number; capRemaining?: number };
  checkedAt: number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** A plain non-negative amount: a finite number, or a string that is only digits and a point. */
function plain(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** USD from a value and the unit its field name states (nano-dollars as SayGM prices use, micros, cents). */
export function toUsd(value: number, key: string): number {
  const k = key.toLowerCase();
  if (/(ndollar|nano)/.test(k)) return value / 1e9;
  if (/(micro|udollar)/.test(k)) return value / 1e6;
  if (/(cent|pence)/.test(k)) return value / 100;
  return value;
}

/**
 * The first amount in `obj` (looking two levels deep) under a field whose name matches `name`
 * and, if given, doesn't match `not`. Returns USD.
 */
export function findAmount(obj: unknown, name: RegExp, not?: RegExp, depth = 0): number | null {
  if (!isObj(obj)) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (!name.test(k) || not?.test(k)) continue;
    const n = plain(v);
    if (n !== null) return toUsd(n, k);
    // { balance: { usd: 12.5 } } or { balance: { amount: "12.5", currency: "USD" } }
    if (isObj(v)) {
      const inner = findAmount(v, /^(usd|amount|value|total|ndollars|micros|cents)/i) ?? findAmount(v, name, not, depth + 1);
      if (inner !== null) return inner;
    }
  }
  if (depth >= 2) return null;
  for (const v of Object.values(obj)) {
    if (!isObj(v)) continue;
    const n = findAmount(v, name, not, depth + 1);
    if (n !== null) return n;
  }
  return null;
}

const fieldNames = (v: unknown): string => (isObj(v) ? Object.keys(v).slice(0, 20).join(", ") : Array.isArray(v) ? "a list" : typeof v);
const warned = new Set<string>();
function unreadable(who: string, body: unknown) {
  if (warned.has(who)) return;
  warned.add(who);
  record({ level: "warn", source: "compat", message: `${who}: the balance answer isn't in a shape BitBull recognises, so no balance is shown`, detail: `Fields in the answer: ${fieldNames(body)}` });
}

async function getJson(url: string, key: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** SayGM's answer → the spendable balance in USD, or null. Exported for tests. */
export function readSaygmCredits(body: unknown): number | null {
  // tokens or request counts are not money
  return findAmount(body, /(balance|credit|available|remaining)/i, /(token|request|count|limit|rate)/i);
}

/** Ditto's endpoint usage → what was spent and what is left under the cap, in USD. Exported for tests. */
export function readDittoUsage(body: unknown): { spent?: number; remaining?: number } {
  // "spend" in Ditto tokens is not dollars: only fields that say USD/dollars/cost count
  const spent = findAmount(body, /^(?=.*(spend|spent|cost|total))(?=.*(usd|dollar)).*$|^cost(usd)?$|^usd$/i, /(cap|limit|remaining|token(?!.*usd))/i);
  const remaining = findAmount(body, /remaining/i, /(token(?!.*usd)|request|count)/i);
  return { ...(spent !== null ? { spent } : {}), ...(remaining !== null ? { remaining } : {}) };
}

async function saygm(): Promise<Balance> {
  const key = config.saygm.apiKey;
  if (!key) return { configured: false, ok: false, note: "No SayGM key set" };
  try {
    const { status, body } = await getJson(`${config.saygm.openaiBaseUrl}/credits`, key);
    if (status === 401 || status === 403) return { configured: true, ok: false, note: "SayGM didn't accept the key for reading the balance" };
    if (status === 404) return { configured: true, ok: false, note: "SayGM has no balance to read with this key" };
    if (status < 200 || status >= 300) return { configured: true, ok: false, note: `SayGM said ${status}` };
    const amount = readSaygmCredits(body);
    if (amount === null) {
      unreadable("SayGM", body);
      return { configured: true, ok: false, note: "SayGM answered, but not in a form BitBull can read yet" };
    }
    return { configured: true, ok: true, amount };
  } catch {
    return { configured: true, ok: false, note: "Couldn't reach SayGM" };
  }
}

async function ditto(): Promise<Balances["ditto"]> {
  const key = config.ditto.apiKey;
  if (!key || !config.router.key) return { configured: false, ok: false, note: config.ditto.apiKey ? "Ditto Router isn't connected" : "Ditto isn't connected" };
  const api = new URL(config.ditto.mcpUrl).origin;
  try {
    const list = await getJson(`${api}/api/v5/inference/endpoints`, key);
    if (list.status === 401 || list.status === 403) return { configured: true, ok: false, note: "Ditto didn't accept the account key (reconnect Ditto)" };
    const eps = isObj(list.body) && Array.isArray(list.body.endpoints) ? (list.body.endpoints as Array<{ id?: unknown; slug?: unknown }>) : [];
    const ep = eps.find((e) => e.slug === "bitbull");
    if (!ep || typeof ep.id !== "string") return { configured: true, ok: false, note: "BitBull's Ditto Router endpoint wasn't found (reconnect Ditto)" };
    const u = await getJson(`${api}/api/v5/inference/endpoints/${encodeURIComponent(ep.id)}/usage`, key);
    if (u.status === 404) return { configured: true, ok: false, note: "Ditto doesn't report usage for this endpoint yet" };
    if (u.status < 200 || u.status >= 300) return { configured: true, ok: false, note: `Ditto said ${u.status}` };
    const { spent, remaining } = readDittoUsage(u.body);
    if (spent === undefined && remaining === undefined) {
      unreadable("Ditto Router", u.body);
      return { configured: true, ok: false, note: "Ditto answered, but not in a form BitBull can read yet" };
    }
    return { configured: true, ok: true, spent30d: spent, capRemaining: remaining };
  } catch {
    return { configured: true, ok: false, note: "Couldn't reach Ditto" };
  }
}

let cache: { at: number; key: string; value: Balances } | null = null;
const TTL = 60_000;

export async function balances(force = false): Promise<Balances> {
  // a changed key must not show the old key's balance
  const sig = `${config.saygm.apiKey.length}:${config.saygm.apiKey.slice(-4)}:${config.ditto.apiKey.slice(-4)}:${config.router.key.slice(-4)}`;
  if (!force && cache && cache.key === sig && Date.now() - cache.at < TTL) return cache.value;
  const [s, d] = await Promise.all([saygm(), ditto()]);
  const value = { saygm: s, ditto: d, checkedAt: Date.now() };
  cache = { at: Date.now(), key: sig, value };
  return value;
}
