/**
 * Cathedral behind BitBull (cathedral.ts): the tools on /mcp/cathedral, called the way an engine
 * calls them (MCP JSON-RPC), with a fake Cathedral that records every request. One test per
 * change the maintainers asked for: the key stays on the server, closed until set (in
 * cathedral-server.test.ts), per project, a real approval, named and logged uploads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

const KEY = "cat_sk_test_dummy_0123456789";
const dir = mkdtempSync(path.join(tmpdir(), "bitbull-cathedral-relay-"));
process.env.DATA_DIR = dir;
process.env.APP_TOKEN = "real-token";
process.env.CATHEDRAL_API_KEY = KEY;
delete process.env.CATHEDRAL_MAX_SPEND_USD;
delete process.env.CATHEDRAL_ALLOW_UNCAPPED_KEY;
delete process.env.CATHEDRAL_API_URL;
after(() => rmSync(dir, { recursive: true, force: true }));

const { config } = await import("./config.js");
const { projects, sessions, workspaceFor } = await import("./db.js");
const { setRunningSessions, setUnattendedCheck } = await import("./mcp.js");
const { recent } = await import("./activity.js");
const C = await import("./cathedral.js");

// ---------- a fake Cathedral ----------

interface Rec {
  method: string;
  path: string;
  headers: Record<string, string>;
  json: any;
  bytes: number;
}
let reqs: Rec[] = [];
const ID = "7a5992ea-9e2e-46f9-81b0-0f94cf62ec70";
const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let catalogModes = ["deny_all", "internet", "allowlist"];
const fake: typeof fetch = async (url: any, init?: RequestInit) => {
  const u = new URL(String(url));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
  const raw = init?.body;
  const bytes = raw ? (typeof raw === "string" ? Buffer.byteLength(raw) : (raw as Buffer).length) : 0;
  let json: any = null;
  try {
    json = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    /* binary */
  }
  const method = init?.method ?? "GET";
  reqs.push({ method, path: u.pathname + u.search, headers, json, bytes });
  const p = u.pathname;
  if (p === "/v1/account") return j(200, { scopes: ["sandboxes:control"], api_key: { budget_usd: "5", committed_usd: "0", remaining_usd: "5" } });
  if (p === "/v1/sandboxes/catalog")
    return j(200, { sealed: { available: true, network_modes: catalogModes, sizes: [{ template: "sealed-1x2", resources: { cpu: 1, memory_gib: 2 }, hourly_rate_usd: "0.005" }] } });
  if (p === "/v1/sandboxes" && method === "POST") return j(201, { id: ID, state: "running", image: "python@sha256:abc", image_digest: "sha256:abc", receipt_id: "r1", receipt_url: "/v1/receipts/r1" });
  if (p === `/v1/sandboxes/${ID}/exec`) return j(200, { exit_code: 0, stdout: "ok\n", stderr: "" });
  if (p === `/v1/sandboxes/${ID}/files` && method === "PUT") return new Response(null, { status: 204 });
  return j(404, { detail: "not_found" });
};
C._setTransport({ fetch: fake, sleep: async () => {} });

// ---------- calling a tool the way an engine does ----------

let rpc = 0;
async function call(tool: string, args: Record<string, unknown>, sessionId?: string): Promise<any> {
  const req = new Request("http://127.0.0.1/mcp/cathedral", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "x-bitbull-session": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpc, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const res = await C.handleCathedralMcp(req);
  const body = (await res.json()) as any;
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const on = projects.create({ name: "Untrusted code", integrations: ["cathedral"] });
const off = projects.create({ name: "Other", integrations: [] });
const chatOn = sessions.create({ engine: "opencode", model: "m", projectId: on.id, title: "check a repo" });
const chatOff = sessions.create({ engine: "opencode", model: "m", projectId: off.id });
const chatLoose = sessions.create({ engine: "opencode", model: "m" });
const ws = workspaceFor(on);
mkdirSync(path.join(ws, "repo"), { recursive: true });
writeFileSync(path.join(ws, "repo", "app.py"), "print('hi')\n");

let unattended = false;
setUnattendedCheck(() => unattended);
setRunningSessions(() => [chatOn.id]);

/** Answer the next approval card as soon as it appears. */
function answerNext(decision: "approve" | "deny") {
  const t = setInterval(() => {
    const p = C.listCreateRequests().find((r) => r.status === "pending");
    if (p) {
      clearInterval(t);
      C.decideCreate(p.id, decision);
    }
  }, 5);
}
const posts = () => reqs.filter((r) => r.method === "POST" && r.path === "/v1/sandboxes");

beforeEach(() => {
  reqs = [];
  unattended = false;
  catalogModes = ["deny_all", "internet", "allowlist"];
});

// ---- 1. the key stays on the server ----

test("1. the agent's tools reach Cathedral through BitBull: the key goes only in the Authorization header, and never back to the agent", async () => {
  answerNext("approve");
  const out = await call("create", { size: "sealed-1x2", lifetime_seconds: 300, reason: "run an untrusted script", op: "c1" }, chatOn.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(reqs.length > 0);
  for (const r of reqs) {
    assert.equal(r.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(r.json ?? "").includes(KEY));
  }
  assert.ok(!JSON.stringify(out).includes(KEY));
  // the spend held is the quote, within the .env limit
  assert.equal(posts()[0].json.max_spend_usd, "0.000417");
});

// ---- 3. per project ----

test("3. per project: refused in a project without Cathedral and in chats outside any project, before any call", async () => {
  for (const sid of [chatOff.id, chatLoose.id]) {
    setRunningSessions(() => [sid]);
    const out = await call("quote", { size: "sealed-1x2", lifetime_seconds: 300 }, sid);
    assert.match(String(out), /not switched on for this chat/);
  }
  setRunningSessions(() => [chatOn.id]);
  assert.equal(reqs.length, 0);
  // the project ticked: answers
  const q = await call("quote", { size: "sealed-1x2", lifetime_seconds: 300 }, chatOn.id);
  assert.equal(q.ok, true);
});

test("3. a call that can't say which chat it came from, with several chats running, is refused", async () => {
  setRunningSessions(() => [chatOn.id, chatOff.id]);
  const out = await call("quote", { size: "sealed-1x2", lifetime_seconds: 300 });
  assert.match(String(out), /Several chats are running/);
  setRunningSessions(() => [chatOn.id]);
  assert.equal(reqs.length, 0);
});

test("3. the integration has no global flag and its MCP is only attached for projects that tick it", async () => {
  const { integrations, mcpServersFor } = await import("./integrations.js");
  assert.equal(integrations().find((i) => i.id === "cathedral")!.global, undefined);
  assert.ok(mcpServersFor(["cathedral"]).cathedral);
  assert.equal(mcpServersFor(["leadpoet", "atlas"]).cathedral, undefined);
});

// ---- 4. a real approval ----

test("4. create raises a card with size, rate, lifetime, spend cap and internet, and creates only after Approve", async () => {
  let seen: any;
  const t = setInterval(() => {
    const p = C.listCreateRequests().find((r) => r.status === "pending");
    if (p) {
      clearInterval(t);
      seen = { ...p };
      assert.equal(posts().length, 0, "nothing created while the card waits");
      C.decideCreate(p.id, "approve");
    }
  }, 5);
  const out = await call("create", { size: "sealed-1x2", lifetime_seconds: 600, reason: "run the tests of a repo I was sent", op: "c2" }, chatOn.id);
  assert.equal(out.ok, true);
  assert.equal(seen.size, "sealed-1x2");
  assert.deepEqual(seen.resources, { cpu: 1, memory_gib: 2 });
  assert.equal(seen.hourlyRateUsd, "0.005000");
  assert.equal(seen.lifetimeSeconds, 600);
  assert.equal(seen.spendCapUsd, "0.000834");
  assert.equal(seen.limitUsd, "0.50");
  assert.equal(seen.internet, false);
  assert.equal(seen.projectId, on.id);
  assert.equal(seen.sessionId, chatOn.id);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].json.network, "deny_all");
});

test("4. Deny: nothing is created", async () => {
  answerNext("deny");
  const out = await call("create", { size: "sealed-1x2", lifetime_seconds: 300, reason: "x", op: "c3" }, chatOn.id);
  assert.equal(out.ok, false);
  assert.equal(out.error, "denied");
  assert.equal(posts().length, 0);
});

test("4. refused in a scheduled run or a Telegram message: no card, no call", async () => {
  unattended = true;
  const before = C.listCreateRequests().length;
  const out = await call("create", { size: "sealed-1x2", lifetime_seconds: 300, reason: "x", op: "c4" }, chatOn.id);
  assert.match(String(out), /scheduled run or a Telegram message/);
  assert.equal(C.listCreateRequests().length, before);
  assert.equal(reqs.length, 0);
});

test("4. internet on shows on the card; a host list means allowlist and never internet", async () => {
  let seen: any;
  const t = setInterval(() => {
    const p = C.listCreateRequests().find((r) => r.status === "pending");
    if (p) {
      clearInterval(t);
      seen = { ...p };
      C.decideCreate(p.id, "approve");
    }
  }, 5);
  const out = await C.createRoom({ purpose: "chat", projectId: on.id, sessionId: chatOn.id, size: "sealed-1x2", lifetimeSeconds: 300, internet: false, allowHosts: ["pypi.org", "files.pythonhosted.org"], reason: "install", op: "c5" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(seen.allowHosts, ["pypi.org", "files.pythonhosted.org"]);
  assert.equal(posts()[0].json.network, "allowlist");
  assert.deepEqual(posts()[0].json.egress_allowlist, ["pypi.org", "files.pythonhosted.org"]);
  const both = await C.createRoom({ purpose: "chat", projectId: on.id, size: "sealed-1x2", lifetimeSeconds: 300, internet: true, allowHosts: ["pypi.org"], reason: "x", op: "c6" });
  assert.equal(both.ok, false);
  // an allowlist the catalog doesn't offer is refused, never widened
  catalogModes = ["deny_all", "internet"];
  answerNext("approve");
  const no = await C.createRoom({ purpose: "chat", projectId: on.id, size: "sealed-1x2", lifetimeSeconds: 300, internet: false, allowHosts: ["pypi.org"], reason: "x", op: "c7" });
  assert.equal(no.error, "network_mode_not_offered");
});

// ---- 5. named, logged uploads ----

test("5. upload sends the one named workspace file and logs path, size and SHA-256 to Activity", async () => {
  const out = await call("upload", { sandbox_id: ID, file: "repo/app.py", path: "/work/app.py", op: "u1" }, chatOn.id);
  assert.equal(out.ok, true, JSON.stringify(out));
  const put = reqs.find((r) => r.method === "PUT")!;
  assert.match(put.path, /path=%2Fwork%2Fapp\.py/);
  assert.equal(put.bytes, 12);
  assert.equal(out.sha256, createHash("sha256").update("print('hi')\n").digest("hex"));
  const log = recent({ limit: 50 }).reverse().find((e) => e.source === "cathedral" && /Sent to Cathedral sandbox/.test(e.message))!;
  assert.ok(log, "logged");
  assert.match(log.message, /repo\/app\.py → \/work\/app\.py \(12 bytes, sha256 [0-9a-f]{64}\)/);
  assert.equal(log.message.match(/sha256 ([0-9a-f]{64})/)![1], out.sha256);
  assert.equal(log.sessionId, chatOn.id);
});

test("5. uploads refuse anything not a named file inside the workspace: escapes, links out, folders, .env, .git", async () => {
  const outside = path.join(dir, "secret.txt");
  writeFileSync(outside, "owner's secret");
  symlinkSync(outside, path.join(ws, "repo", "link.txt"));
  writeFileSync(path.join(ws, "repo", ".env"), "TOKEN=1");
  mkdirSync(path.join(ws, "repo", ".git"), { recursive: true });
  writeFileSync(path.join(ws, "repo", ".git", "config"), "[core]");
  for (const file of ["../../secret.txt", outside, "repo/link.txt", "repo", "repo/.env", "repo/.git/config", "repo/missing.py"]) {
    const out = await call("upload", { sandbox_id: ID, file, path: "/work/x", op: "u2" }, chatOn.id);
    assert.equal(out.ok, false, file);
    assert.equal(out.error, "file_refused", file);
  }
  assert.equal(reqs.filter((r) => r.method === "PUT").length, 0);
  // a template is fine
  writeFileSync(path.join(ws, "repo", ".env.example"), "TOKEN=");
  assert.equal(typeof C.namedFile(ws, "repo/.env.example", true), "string");
});

// ---- ownership ----

test("exec, upload and delete work only on rooms this project created; nothing is sent for another", async () => {
  const stranger = "0b0b0b0b-0000-4000-8000-000000000000";
  for (const [tool, args] of [
    ["exec", { sandbox_id: stranger, command: "id", op: "e1" }],
    ["upload", { sandbox_id: stranger, file: "repo/app.py", path: "/work/a", op: "u3" }],
    ["delete", { sandbox_id: stranger }],
  ] as const) {
    const out = await call(tool, args, chatOn.id);
    assert.match(String(out), /not created from this project/, tool);
  }
  assert.equal(reqs.length, 0);
  // the room created above is this project's: exec reaches it
  const ok = await call("exec", { sandbox_id: ID, command: "echo ok", op: "e2" }, chatOn.id);
  assert.equal(ok.ok, true);
  // ...and from another project it is a stranger
  setRunningSessions(() => [chatOff.id]);
  projects.update(off.id, { integrations: ["cathedral"] });
  const other = await call("exec", { sandbox_id: ID, command: "id", op: "e3" }, chatOff.id);
  assert.match(String(other), /not created from this project/);
  projects.update(off.id, { integrations: [] });
  setRunningSessions(() => [chatOn.id]);
});

// ---- QA Hound grant ----

test("review_exec: only the granted reviewer chats, only while the grant lasts", async () => {
  const reviewer = sessions.create({ engine: "opencode", model: "m", projectId: on.id });
  setRunningSessions(() => [reviewer.id]);
  assert.match(String(await call("review_exec", { sandbox_id: ID, command: "pytest", op: "r1" }, reviewer.id)), /not open to this review/);
  C.grantRoom(ID, "thound1", [reviewer.id], 60_000);
  assert.match(String(await call("review_exec", { sandbox_id: ID, command: "pytest", op: "r1" }, chatOn.id)), /Only the reviewers/);
  const ok = await call("review_exec", { sandbox_id: ID, command: "pytest", op: "r1" }, reviewer.id);
  assert.equal(ok.ok, true);
  const ex = reqs.filter((r) => r.path.endsWith("/exec")).at(-1)!;
  assert.equal(ex.json.cwd, "/work/src");
  assert.equal(ex.headers["idempotency-key"], "bitbull-thound1-r1");
  C.revokeRoom(ID);
  assert.match(String(await call("review_exec", { sandbox_id: ID, command: "pytest", op: "r2" }, reviewer.id)), /not open to this review/);
  setRunningSessions(() => [chatOn.id]);
});

test("no key: every tool says Cathedral is not set up, and nothing is sent", async () => {
  const saved = config.integrations.cathedral.apiKey;
  config.integrations.cathedral.apiKey = "";
  const out = await call("quote", { size: "sealed-1x2", lifetime_seconds: 300 }, chatOn.id);
  assert.match(String(out), /not set up/);
  config.integrations.cathedral.apiKey = saved;
  assert.equal(reqs.length, 0);
});

test("review_exec from OpenCode (no session header): allowed while one of the run's reviewers is running, even beside other chats", async () => {
  const reviewer = sessions.create({ engine: "opencode", model: "m", projectId: on.id });
  C.grantRoom(ID, "thound2", [reviewer.id], 60_000);
  setRunningSessions(() => [chatOn.id, reviewer.id]);
  const ok = await call("review_exec", { sandbox_id: ID, command: "pytest", op: "r3" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  setRunningSessions(() => [chatOn.id]);
  assert.match(String(await call("review_exec", { sandbox_id: ID, command: "pytest", op: "r4" })), /Only the reviewers/);
  C.revokeRoom(ID);
});

test("rooms made for QA Hound or a clean-machine test are the run's alone: the chat tools can't exec, upload, delete or list them", async () => {
  C._resetCathedral();
  answerNext("approve");
  const made = await C.createRoom({ purpose: "clean-machine", projectId: on.id, sessionId: chatOn.id, size: "sealed-1x2", lifetimeSeconds: 300, internet: false, reason: "x", op: "q1" });
  assert.equal(made.ok, true);
  reqs = [];
  for (const [tool, args] of [
    ["exec", { sandbox_id: ID, command: "rm -rf /work/src", op: "x1" }],
    ["upload", { sandbox_id: ID, file: "repo/app.py", path: "/work/src/app.py", op: "x2" }],
    ["delete", { sandbox_id: ID }],
    ["status", { sandbox_id: ID }],
  ] as const) assert.match(String(await call(tool, args, chatOn.id)), /QA Hound run|this project's chats/, tool);
  assert.deepEqual((await call("list", {}, chatOn.id)).sandboxes, []);
  assert.equal(reqs.length, 0);
});

test("upload checks the file a link leads to: a repo's notes.txt -> ../.env is refused", async () => {
  writeFileSync(path.join(ws, ".env"), "OWNER_TOKEN=secret");
  symlinkSync(path.join(ws, ".env"), path.join(ws, "repo", "notes.txt"));
  mkdirSync(path.join(ws, ".git"), { recursive: true });
  writeFileSync(path.join(ws, ".git", "config"), "[credential]");
  symlinkSync(path.join(ws, ".git", "config"), path.join(ws, "repo", "readme.txt"));
  for (const f of ["repo/notes.txt", "repo/readme.txt"]) {
    const r = C.namedFile(ws, f, true);
    assert.equal(typeof r, "object", f);
  }
});

test("stopping the turn closes its waiting card: a later Approve creates nothing", async () => {
  const t = setInterval(() => {
    const p = C.listCreateRequests().find((r) => r.status === "pending" && r.sessionId === chatOn.id);
    if (p) {
      clearInterval(t);
      assert.equal(C.cancelCreates(chatOn.id), 1);
      assert.equal(C.decideCreate(p.id, "approve")?.status, "denied", "an Approve after the stop changes nothing");
    }
  }, 5);
  const out = await call("create", { size: "sealed-1x2", lifetime_seconds: 300, reason: "stopped before approval", op: "c9" }, chatOn.id);
  assert.equal(out.ok, false);
  assert.equal(out.error, "denied");
  assert.equal(posts().length, 0);
});

test("download refuses a folder that is a link into .git", () => {
  mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  symlinkSync(path.join(ws, ".git"), path.join(ws, "gitlink"));
  const r = C.namedFile(ws, "gitlink/hooks/pre-commit", false);
  assert.equal(typeof r, "object");
  assert.match((r as { error: string }).error, /\.git/);
});
