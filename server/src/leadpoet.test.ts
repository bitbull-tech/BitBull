/**
 * Leadpoet sign-in and relay, against a stand-in Leadpoet (OAuth with PKCE + an MCP endpoint):
 * the sign-in can't be hijacked or pointed elsewhere, sending is asked for only when the owner
 * chose it, the tokens never leave the server, and an expired or revoked sign-in is handled.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// ---------- a stand-in leadpoet.com ----------
const hits = { register: 0, token: 0, mcp: [] as Array<{ auth: string; body: string; session: string }> };
const codes = new Map<string, { challenge: string; clientId: string; redirect: string; scope: string }>();
let issued = 0;
let validAccess = "";
let validRefresh = "";
let lifetime = 3600;
let evilMeta = false;
let refuseRefresh = false;
const mint = () => {
  issued++;
  validAccess = `lp-access-${issued}-${"a".repeat(24)}`;
  validRefresh = `lp-refresh-${issued}-${"r".repeat(24)}`;
  return { access_token: validAccess, refresh_token: validRefresh, expires_in: lifetime, token_type: "Bearer" };
};

const lp = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const self = `http://127.0.0.1:${(lp.address() as AddressInfo).port}`;
    const j = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? "/", self);
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return j(200, {
        issuer: self,
        authorization_endpoint: `${self}/oauth/authorize`,
        token_endpoint: evilMeta ? "https://evil.example/oauth/token" : `${self}/oauth/token`,
        registration_endpoint: `${self}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/oauth/register") {
      hits.register++;
      const b = JSON.parse(raw);
      assert.equal(b.token_endpoint_auth_method, "none");
      return j(201, { client_id: `client-${hits.register}`, redirect_uris: b.redirect_uris });
    }
    if (url.pathname === "/oauth/token") {
      hits.token++;
      const p = new URLSearchParams(raw);
      if (p.get("resource") !== `${self}/mcp`) return j(400, { error: "invalid_target" });
      if (p.get("grant_type") === "authorization_code") {
        const c = codes.get(p.get("code") ?? "");
        codes.delete(p.get("code") ?? "");
        const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== challenge || c.clientId !== p.get("client_id") || c.redirect !== p.get("redirect_uri")) return j(400, { error: "invalid_grant", error_description: "bad code or verifier" });
        return j(200, { ...mint(), scope: c.scope });
      }
      if (p.get("grant_type") === "refresh_token") {
        if (refuseRefresh || p.get("refresh_token") !== validRefresh) return j(400, { error: "invalid_grant" });
        return j(200, mint());
      }
      return j(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const auth = req.headers.authorization ?? "";
      hits.mcp.push({ auth, body: raw, session: String(req.headers["mcp-session-id"] ?? "") });
      if (auth !== `Bearer ${validAccess}`) return j(401, { error: "invalid_token" }, { "www-authenticate": "Bearer" });
      return j(200, { jsonrpc: "2.0", id: JSON.parse(raw).id, result: { ok: true } }, { "mcp-session-id": "sess-1" });
    }
    j(404, {});
  });
});
await new Promise<void>((r) => lp.listen(0, "127.0.0.1", r));
const LP = `http://127.0.0.1:${(lp.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-leadpoet-"));
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";
process.env.LEADPOET_URL = LP;
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const { config } = await import("./config.js");
const { recent, redact } = await import("./activity.js");
const { builtIn } = await import("./egress.js");
const { integrations, mcpServersFor } = await import("./integrations.js");
const L = await import("./leadpoet.js");

after(() => lp.close());

const APP = "http://127.0.0.1:8787";
/** What the owner's browser does at Leadpoet: approve, and be sent back with a code. */
function approve(authUrl: string) {
  const q = new URL(authUrl).searchParams;
  const code = `code-${codes.size}-${Date.now()}`;
  codes.set(code, { challenge: q.get("code_challenge")!, clientId: q.get("client_id")!, redirect: q.get("redirect_uri")!, scope: q.get("scope")! });
  return { code, state: q.get("state")! };
}
const rpc = (name: string, id = 1) =>
  new Request("http://127.0.0.1/mcp/leadpoet", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "sess-1", cookie: "nope=1", "x-bitbull-internal": "secret" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { secret: "do-not-log" } } }),
  });

test("the callback address must be this BitBull: this computer or https", () => {
  assert.equal(L.redirectFor("http://127.0.0.1:8787"), "http://127.0.0.1:8787/oauth/leadpoet/callback");
  assert.equal(L.redirectFor("http://localhost:8787/"), "http://localhost:8787/oauth/leadpoet/callback");
  assert.equal(L.redirectFor("https://bitbull.example.com"), "https://bitbull.example.com/oauth/leadpoet/callback");
  assert.throws(() => L.redirectFor("http://192.168.1.20:8787"), /this computer|https/);
  assert.throws(() => L.redirectFor("http://evil.example"), /this computer|https/);
  assert.throws(() => L.redirectFor("javascript:alert(1)"), /this computer|https/);
  assert.throws(() => L.redirectFor("nonsense"));
});

test("scopes: sending is only ever asked for when the owner chose it, and never with read-only", () => {
  assert.ok(!L.scopesFor("edit", false).includes("outreach:send"));
  assert.ok(L.scopesFor("edit", true).includes("outreach:send"));
  assert.ok(!L.scopesFor("read", true).includes("outreach:send"));
  assert.ok(!L.scopesFor("read", false).some((s) => s.endsWith(":write")));
});

test("nothing is open or attached before connecting", async () => {
  assert.equal(builtIn("127.0.0.1"), false);
  assert.equal(L.leadpoetState().connected, false);
  assert.equal(integrations().find((i) => i.id === "leadpoet")!.mcp, undefined);
  assert.deepEqual(mcpServersFor(["leadpoet"]), {});
  const res = await L.proxyMcp(rpc("getCredits"));
  assert.equal(res.status, 401);
  assert.equal(hits.mcp.length, 0, "nothing is sent to Leadpoet without a sign-in");
});

test("connect: PKCE, a one-time state, no sending by default; a stranger's callback does nothing", async () => {
  const s = await L.startConnect({ origin: APP });
  const q = new URL(s.pending!.url).searchParams;
  assert.ok(s.pending!.url.startsWith(`${LP}/oauth/authorize?`));
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("redirect_uri"), `${APP}/oauth/leadpoet/callback`);
  assert.equal(q.get("resource"), `${LP}/mcp`);
  assert.ok(q.get("state")!.length >= 24);
  assert.ok(!q.get("scope")!.includes("outreach:send"));
  assert.ok(q.get("scope")!.includes("lead_engine:write"));
  assert.equal(builtIn("127.0.0.1"), true, "the proxy lets Leadpoet through while a sign-in is under way");

  await assert.rejects(L.finishConnect({ code: "stolen", state: "guess" }), /isn't the one BitBull started/);
  await assert.rejects(L.finishConnect({ code: "stolen", state: null }), /isn't the one BitBull started/);
  assert.equal(L.leadpoetState().connected, false);

  const back = approve(s.pending!.url);
  const done = await L.finishConnect(back);
  assert.equal(done.connected, true);
  assert.equal(done.access, "edit");
  assert.equal(done.send, false);
  assert.equal(done.pending, null);
  await assert.rejects(L.finishConnect(back), /isn't the one BitBull started/, "a state works once");

  // nothing the UI or the engines see carries a token
  assert.ok(!JSON.stringify(L.leadpoetState()).includes("lp-access"));
  const mcp = mcpServersFor(["leadpoet"]).leadpoet;
  assert.match(mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/leadpoet$/);
  assert.ok(!JSON.stringify(mcp).includes("lp-"), "the engines get a local address, not Leadpoet's token");
  assert.equal(redact(`x ${validAccess} y ${validRefresh}`), "x [REDACTED] y [REDACTED]");
  for (const e of recent({ limit: 500 })) assert.ok(!JSON.stringify(e).includes("lp-access") && !JSON.stringify(e).includes("lp-refresh"));
  // saved like a key typed into Settings
  assert.ok(readFileSync(path.join(process.env.DATA_DIR!, "settings.local.json"), "utf8").includes("LEADPOET_OAUTH"));
});

test("the relay adds the sign-in, passes only MCP headers on, and logs tool names only", async () => {
  hits.mcp.length = 0;
  const res = await L.proxyMcp(rpc("createRequest", 7));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("mcp-session-id"), "sess-1");
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 7, result: { ok: true } });
  assert.equal(hits.mcp[0].auth, `Bearer ${validAccess}`);
  assert.equal(hits.mcp[0].session, "sess-1");
  const log = recent({ limit: 20 }).map((e) => e.message);
  assert.ok(log.includes("Leadpoet: createRequest"));
  assert.ok(!JSON.stringify(recent({ limit: 20 })).includes("do-not-log"), "arguments are not logged");
});

test("an expired token is renewed before the call; one Leadpoet refuses is renewed and retried once", async () => {
  // about to expire: refresh first
  const saved = JSON.parse(config.integrations.leadpoet.oauth);
  const { updateSettings } = await import("./settings.js");
  await updateSettings({ LEADPOET_OAUTH: JSON.stringify({ ...saved, expiresAt: Date.now() + 5000 }) }, { internal: true });
  const before = validAccess;
  hits.mcp.length = 0;
  assert.equal((await L.proxyMcp(rpc("getPipeline"))).status, 200);
  assert.notEqual(validAccess, before);
  assert.equal(hits.mcp.length, 1);
  assert.equal(hits.mcp[0].auth, `Bearer ${validAccess}`);

  // Leadpoet rotated the token behind BitBull's back: 401, renew, retry
  const stale = validAccess;
  validAccess = "rotated-elsewhere-000000000000";
  hits.mcp.length = 0;
  const res = await L.proxyMcp(rpc("getPipeline"));
  assert.equal(res.status, 200);
  assert.equal(hits.mcp.length, 2);
  assert.equal(hits.mcp[0].auth, `Bearer ${stale}`);
  assert.equal(hits.mcp[1].auth, `Bearer ${validAccess}`);
});

test("reconnecting with sending: same registration, the wider scope, and it is flagged", async () => {
  const registered = hits.register;
  const s = await L.startConnect({ origin: APP, access: "edit", send: true });
  assert.ok(new URL(s.pending!.url).searchParams.get("scope")!.includes("outreach:send"));
  assert.equal(hits.register, registered, "BitBull registers once per address");
  const done = await L.finishConnect(approve(s.pending!.url));
  assert.equal(done.send, true);
  assert.ok(recent({ limit: 10 }).some((e) => e.level === "warn" && /sending allowed/.test(e.message)));
});

test("declined in Leadpoet, or a sign-in pasted by hand", async () => {
  let s = await L.startConnect({ origin: APP, access: "read" });
  const state = new URL(s.pending!.url).searchParams.get("state")!;
  await assert.rejects(L.finishConnect({ state, error: "access_denied" }), /declined/);
  assert.equal(L.leadpoetState().send, true, "a declined attempt leaves the existing connection alone");

  s = await L.startConnect({ origin: APP, access: "read" });
  const back = approve(s.pending!.url);
  await assert.rejects(L.finishFromUrl("not an address"), /whole address/);
  const done = await L.finishFromUrl(`${APP}/oauth/leadpoet/callback?code=${back.code}&state=${back.state}`);
  assert.equal(done.access, "read");
  assert.equal(done.send, false);
});

test("a revoked sign-in disconnects cleanly and closes the proxy opening", async () => {
  refuseRefresh = true;
  validAccess = "revoked-000000000000000000";
  const res = await L.proxyMcp(rpc("getCredits"));
  assert.equal(res.status, 401);
  assert.equal(L.leadpoetState().connected, false);
  assert.match(L.leadpoetState().error, /Connect again/);
  assert.equal(config.integrations.leadpoet.oauth, "");
  refuseRefresh = false;
  L._resetLeadpoet();
  assert.equal(builtIn("127.0.0.1"), false);
});

test("sign-in details that point somewhere else are refused before anything is sent there", async () => {
  evilMeta = true;
  await assert.rejects(L.startConnect({ origin: APP }), /points somewhere else/);
  assert.equal(L.leadpoetState().pending, null);
  assert.match(L.leadpoetState().error, /points somewhere else/);
  evilMeta = false;
  L._resetLeadpoet();
});

test("disconnect forgets the sign-in", async () => {
  const s = await L.startConnect({ origin: APP });
  await L.finishConnect(approve(s.pending!.url));
  assert.equal(L.leadpoetState().connected, true);
  const d = await L.disconnect();
  assert.equal(d.connected, false);
  assert.equal(config.integrations.leadpoet.oauth, "");
  assert.equal(mcpServersFor(["leadpoet"]).leadpoet, undefined);
});
