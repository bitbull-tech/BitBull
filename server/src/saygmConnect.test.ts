/** Connect with SayGM, against a stand-in for SayGM's account API. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dataDir = mkdtempSync(path.join(tmpdir(), "bitbull-saygm-"));
process.env.DATA_DIR = dataDir;
process.env.APP_TOKEN = "test-token";
process.env.SAYGM_API_KEY = "";
process.env.SAYGM_OAUTH_CLIENT_ID = "bitbull-test-client";
process.env.SAYGM_REF = "17swtkpu";

const { config } = await import("./config.js");
const { redact } = await import("./activity.js");
const S = await import("./saygmConnect.js");

// built here so nothing key-shaped is in the file
const KEY = ["gm", "inference", "stand", "in", "0123456789abcdef"].join("-");
const ACCESS = ["access", "stand", "in", "0123456789"].join("-");
const REFRESH = ["refresh", "stand", "in", "0123456789"].join("-");

interface Call {
  url: string;
  body: Record<string, string>;
  auth?: string;
  redirect?: string;
}
function saygm(over: { token?: [number, unknown]; me?: [number, unknown]; revoke?: number } = {}) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {}, auth: h.authorization, redirect: init?.redirect });
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (u === "https://account.saygm.com/v1/oauth/token") return json(...(over.token ?? [200, { access_token: ACCESS, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH, scope: "inference:use usage:read profile:read", inference_api_key: KEY }]));
    if (u === "https://account.saygm.com/v1/me") return json(...(over.me ?? [200, { id: "u1", email: "owner@example.com" }]));
    if (u === "https://account.saygm.com/v1/oauth/revoke") return json(over.revoke ?? 200, {});
    throw new Error(`unexpected request to ${u}`);
  }) as typeof fetch;
  return { f, calls };
}
const start = (origin = "http://127.0.0.1:8787") => {
  const s = S.startConnect({ origin });
  const u = new URL(s.pending!.url);
  return { s, u, state: u.searchParams.get("state")! };
};

test("the sign-in address: PKCE, the three permissions, the exact callback and the referral code", () => {
  const { s, u } = start();
  assert.equal(u.origin + u.pathname, "https://saygm.com/oauth/authorize");
  const q = u.searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("client_id"), "bitbull-test-client");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:8787/oauth/saygm/callback");
  assert.equal(q.get("scope"), "inference:use usage:read profile:read");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(q.get("state")!.length >= 16 && q.get("state")!.length <= 512);
  assert.equal(q.get("ref"), "17swtkpu");
  assert.equal(s.connected, false);
  assert.equal(s.signupUrl, "https://saygm.com/r/17swtkpu");
  // a fresh state and challenge every time
  assert.notEqual(start().state, start().state);
});

test("only BitBull's registered addresses can start it", () => {
  for (const ok of ["http://127.0.0.1:8787", "http://localhost:8787", "http://127.0.0.1:8788", "http://localhost:8788"]) assert.equal(S.redirectFor(ok), `${ok}/oauth/saygm/callback`);
  for (const bad of ["https://bitbull.example.com", "http://127.0.0.1:9999", "http://192.168.1.5:8787", "http://evil.example:8787", "not a url", "http://localhost"]) assert.throws(() => S.redirectFor(bad), /computer it runs on|own address/, bad);
});

test("coming back: the code is exchanged with the verifier, the key and tokens are saved, the account is named", async () => {
  const { u, state } = start();
  const { f, calls } = saygm();
  const s = await S.finishConnect({ code: "the-code", state, error: null }, f);
  assert.equal(s.connected, true);
  assert.equal(s.email, "owner@example.com");
  assert.deepEqual(s.scopes, ["inference:use", "usage:read", "profile:read"]);
  assert.equal(s.pending, null);
  const tok = calls[0];
  assert.equal(tok.url, "https://account.saygm.com/v1/oauth/token");
  assert.equal(tok.redirect, "error");
  assert.equal(tok.body.grant_type, "authorization_code");
  assert.equal(tok.body.client_id, "bitbull-test-client");
  assert.equal(tok.body.code, "the-code");
  assert.equal(tok.body.redirect_uri, "http://127.0.0.1:8787/oauth/saygm/callback");
  // the verifier sent is the one whose hash went to SayGM at the start
  assert.equal(createHash("sha256").update(tok.body.code_verifier).digest("base64url"), u.searchParams.get("code_challenge"));
  assert.equal(calls[1].url, "https://account.saygm.com/v1/me");
  assert.equal(calls[1].auth, `Bearer ${ACCESS}`);
  // saved where a pasted key would be, and nothing of it is in the state BitBull's page sees
  assert.equal(config.saygm.apiKey, KEY);
  assert.ok(!JSON.stringify(s).includes(KEY) && !JSON.stringify(s).includes(ACCESS) && !JSON.stringify(s).includes(REFRESH));
  // and all three are redacted wherever text is shown
  assert.equal(redact(`key ${KEY} access ${ACCESS} refresh ${REFRESH}`), "key [REDACTED] access [REDACTED] refresh [REDACTED]");
  // a code can't be used twice
  await assert.rejects(S.finishConnect({ code: "the-code", state, error: null }, f), /no SayGM sign-in waiting/);
});

test("disconnect revokes BitBull on SayGM and forgets the key", async () => {
  const { f, calls } = saygm();
  const s = await S.disconnect(f);
  assert.equal(calls[0].url, "https://account.saygm.com/v1/oauth/revoke");
  assert.equal(calls[0].body.token, REFRESH);
  assert.equal(s.connected, false);
  assert.equal(s.note, undefined);
  assert.equal(config.saygm.apiKey, "");
  assert.equal(config.saygm.oauth, "");
  assert.doesNotMatch(readFileSync(path.join(dataDir, "settings.local.json"), "utf8"), /stand-in/);
  // SayGM unreachable: still forgotten here, and the owner is told to remove it there
  const { state } = start();
  await S.finishConnect({ code: "c", state, error: null }, saygm().f);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const s2 = await S.disconnect(down);
  assert.equal(s2.connected, false);
  assert.match(s2.note!, /Connected apps on saygm\.com/);
  assert.equal(config.saygm.apiKey, "");
});

test("what doesn't connect: the wrong state, a refusal, no key, SayGM saying no", async () => {
  // someone else's callback: nothing happens, and the real sign-in is still waiting
  const a = start();
  await assert.rejects(S.finishConnect({ code: "x", state: "another-state-altogether-0123456789", error: null }, saygm().f), /doesn't match the sign-in/);
  assert.ok(S.saygmConnectState().pending);
  // the owner pressed Deny
  await assert.rejects(S.finishConnect({ code: null, state: a.state, error: "access_denied" }, saygm().f), /chose not to connect/);
  assert.equal(S.saygmConnectState().connected, false);
  assert.match(S.saygmConnectState().error, /chose not to connect/);
  // allowed, but without "use models": no key, so it is taken back on SayGM and nothing is saved
  const b = start();
  const noKey = saygm({ token: [200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: "profile:read" }] });
  await assert.rejects(S.finishConnect({ code: "c", state: b.state, error: null }, noKey.f), /without a key for models/);
  assert.equal(noKey.calls.at(-1)!.url, "https://account.saygm.com/v1/oauth/revoke");
  assert.equal(config.saygm.apiKey, "");
  // SayGM refuses the code
  const c = start();
  await assert.rejects(S.finishConnect({ code: "old", state: c.state, error: null }, saygm({ token: [400, { error: "invalid_grant", error_description: "code expired" }] }).f), /refused the sign-in \(400, invalid_grant: code expired\)/);
  // nothing waiting at all
  S._resetSaygmConnect();
  await assert.rejects(S.finishConnect({ code: "c", state: "s", error: null }, saygm().f), /no SayGM sign-in waiting/);
  // the profile failing doesn't stop a good connection
  const d = start();
  const s = await S.finishConnect({ code: "c", state: d.state, error: null }, saygm({ me: [500, {}] }).f);
  assert.equal(s.connected, true);
  assert.equal(s.email, "");
  await S.disconnect(saygm().f);
});

test("BitBull ships with its client id; switched off, Connect isn't offered and says so", async () => {
  {
    const { reloadConfig } = await import("./config.js");
    const mine = process.env.SAYGM_OAUTH_CLIENT_ID;
    delete process.env.SAYGM_OAUTH_CLIENT_ID;
    reloadConfig();
    assert.match(config.saygm.oauthClientId, /^sgm_[A-Za-z0-9_-]{20,}$/, "the registered BitBull app is the default");
    process.env.SAYGM_OAUTH_CLIENT_ID = mine;
    reloadConfig();
  }
  const { reloadConfig } = await import("./config.js");
  const before = process.env.SAYGM_OAUTH_CLIENT_ID;
  process.env.SAYGM_OAUTH_CLIENT_ID = "off";
  reloadConfig();
  try {
    assert.equal(S.saygmConnectState().available, false);
    assert.throws(() => S.startConnect({ origin: "http://127.0.0.1:8787" }), /isn't set up in this BitBull yet/);
  } finally {
    process.env.SAYGM_OAUTH_CLIENT_ID = before;
    reloadConfig();
  }
});
