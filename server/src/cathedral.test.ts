/**
 * tools/cathedral.mjs through run(argv, {env, fetch, sleep}) with a fake fetch that records every
 * request. Nothing here touches the network or a real key: the key is a dummy, and the https rule
 * is never relaxed (the fake fetch stands in for the whole network).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const { run } = (await import(pathToFileURL(path.join(root, "tools/cathedral.mjs")).href)) as {
  run: (argv: string[], deps: { env: Record<string, string | undefined>; fetch: typeof fetch; sleep: (ms: number) => Promise<void> }) => Promise<{ code: number; out: any; stdout: string; stderr: string }>;
};

const KEY = "cat_sk_test_dummy_0123456789";
const ID = "7a5992ea-9e2e-46f9-81b0-0f94cf62ec70";
const EXEC = "9b1c2d3e-0000-4000-8000-00000000abcd";
const TASK = "t0abc123def4";
const tmp = mkdtempSync(path.join(tmpdir(), "bitbull-cathedral-helper-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------- harness ----------

interface Rec {
  method: string;
  url: string;
  path: string;
  q: URLSearchParams;
  headers: Record<string, string>;
  json: any;
  raw: Buffer | null;
}
type Handler = (req: Rec, i: number) => Response | Error | Promise<Response | Error>;
type Route = [method: string, re: RegExp, handler: Handler];

const j = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const bin = (status: number, bytes: Uint8Array | Buffer) => new Response(new Uint8Array(bytes), { status, headers: { "content-type": "application/octet-stream" } });
const empty = (status: number) => new Response(null, { status });

/** Answers in order; the last one repeats. Each item is a factory because a body can be read once. */
const seq =
  (...items: Array<(() => Response) | Error>): Handler =>
  (_r, i) => {
    const it = items[Math.min(i, items.length - 1)];
    return it instanceof Error ? it : it();
  };
const once = (f: () => Response): Handler => seq(f);

const SIZES = [
  { template: "sealed-1x2", resources: { cpu: 1, memory_gib: 2, disk_gib: 10 }, hourly_rate_usd: "0.0175" },
  { template: "sealed-2x4", resources: { cpu: 2, memory_gib: 4, disk_gib: 10 }, hourly_rate_usd: "0.035" },
  { template: "sealed-4x8", resources: { cpu: 4, memory_gib: 8, disk_gib: 10 }, hourly_rate_usd: "0.07" },
  { template: "sealed-8x16", resources: { cpu: 8, memory_gib: 16, disk_gib: 10 }, hourly_rate_usd: "0.14" },
];
const catalogBody = (over: Record<string, unknown> = {}, sizes = SIZES) => ({ sealed: { available: true, network_modes: ["deny_all", "internet"], sizes, ...over } });
const acctBody = (over: Record<string, unknown> = {}) => ({
  scopes: ["sandboxes:control"],
  api_key: { id: "k1", expires_at: null, budget_usd: "5.000000", committed_usd: "1.000000", remaining_usd: "4.000000" },
  ...over,
});
const sandbox = (state: string, over: Record<string, unknown> = {}) => ({ id: ID, state, template: "sealed-1x2", labels: {}, failed_by: null, billed: null, ...over });

const A = (m: string, p: string) => [m, new RegExp(`^${p}$`)] as const;
const defaults = (): Route[] => [
  ["GET", /^\/v1\/account$/, once(() => j(200, acctBody()))],
  ["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, catalogBody()))],
];

interface Run {
  r: { code: number; out: any; stdout: string; stderr: string };
  reqs: Rec[];
  sleeps: number[];
}
async function go(argv: string[], routes: Route[] = [], envOver: Record<string, string | undefined> = {}): Promise<Run> {
  const reqs: Rec[] = [];
  const counts = new Map<Route, number>();
  const table = [...routes, ...defaults()];
  const fake = (async (input: any, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let raw: Buffer | null = null;
    let parsed: any = null;
    if (init.body !== undefined && init.body !== null) {
      const body: Buffer = Buffer.isBuffer(init.body) ? init.body : init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init.body));
      raw = body;
      if ((headers["content-type"] ?? "").includes("json")) parsed = JSON.parse(body.toString("utf8"));
    }
    const req: Rec = { method: (init.method ?? "GET").toUpperCase(), url: u.toString(), path: u.pathname, q: u.searchParams, headers, json: parsed, raw };
    reqs.push(req);
    const route = table.find(([m, re]) => m === req.method && re.test(req.path));
    if (!route) throw new Error(`fake fetch: no route for ${req.method} ${req.path}`);
    const i = counts.get(route) ?? 0;
    counts.set(route, i + 1);
    const res = await route[2](req, i);
    if (res instanceof Error) throw res;
    return res;
  }) as typeof fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const r = await run(argv, { env: { CATHEDRAL_API_KEY: KEY, ...envOver }, fetch: fake, sleep });
  return { r, reqs, sleeps };
}
const posts = (reqs: Rec[], re: RegExp) => reqs.filter((q) => q.method === "POST" && re.test(q.path));
const CREATE = (size = "sealed-1x2", extra: string[] = []) => ["create", "--task", TASK, "--op", "create", "--size", size, "--lifetime", "300", "--max-spend", "0.01", ...extra];
const createRoute = (f: () => Response = () => j(200, sandbox("running", { receipt_id: "r1" }))): Route => ["POST", /^\/v1\/sandboxes$/, once(f)];
const dropped = () => Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });

// ---------- tags, key, url ----------

test("new-task prints a fresh random tag: t plus 12 lowercase letters and digits; no request, no key needed", async () => {
  const a = await go(["new-task"], [], { CATHEDRAL_API_KEY: undefined });
  const b = await go(["new-task"], [], { CATHEDRAL_API_KEY: undefined });
  assert.equal(a.r.code, 0);
  assert.equal(a.reqs.length, 0);
  assert.match(a.r.out.task, /^t[a-z0-9]{12}$/);
  assert.notEqual(a.r.out.task, b.r.out.task);
  const many = new Set<string>();
  for (let i = 0; i < 40; i++) many.add((await go(["new-task"])).r.out.task);
  assert.equal(many.size, 40);
  assert.equal(a.r.stdout.trim().split("\n").length, 1, "exactly one JSON object");
  assert.deepEqual(JSON.parse(a.r.stdout), a.r.out);
});

test("a missing key or a non-https URL refuses before any request", async () => {
  let x = await go(["catalog"], [], { CATHEDRAL_API_KEY: undefined });
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.ok, false);
  assert.equal(x.reqs.length, 0);
  x = await go(["catalog"], [], { CATHEDRAL_API_URL: "http://cathedral.example" });
  assert.equal(x.r.code, 1);
  assert.match(x.r.out.message, /https/);
  assert.equal(x.reqs.length, 0);
  x = await go(["catalog"], [], { CATHEDRAL_API_URL: "https://cathedral.example/" });
  assert.equal(x.reqs[0].url, "https://cathedral.example/v1/sandboxes/catalog");
});

// ---------- success paths ----------

test("catalog and account print one JSON object and send the bearer key", async () => {
  const c = await go(["catalog"]);
  assert.equal(c.r.code, 0);
  assert.equal(c.r.out.ok, true);
  assert.equal(c.r.out.sealed.available, true);
  assert.deepEqual(c.r.out.sealed.sizes.map((s: any) => s.template), ["sealed-1x2", "sealed-2x4", "sealed-4x8", "sealed-8x16"]);
  assert.equal(c.reqs.length, 1);
  assert.equal(c.reqs[0].method, "GET");
  assert.equal(c.reqs[0].url, "https://cathedral.computer/v1/sandboxes/catalog");
  assert.equal(c.reqs[0].headers.authorization, `Bearer ${KEY}`);

  const a = await go(["account"], [], { CATHEDRAL_MAX_SPEND_USD: "0.75" });
  assert.equal(a.r.code, 0);
  assert.equal(a.reqs[0].path, "/v1/account");
  assert.deepEqual(a.r.out.scopes, ["sandboxes:control"]);
  assert.equal(a.r.out.api_key.remaining_usd, "4.000000");
  assert.equal(a.r.out.effective_cap_usd, "0.750000");
  assert.equal(a.r.out.uncapped_allowed, false);
  assert.ok(!("email" in a.r.out), "personal fields are not printed");
});

test("quote: the hold for each size at 60 s, 3600 s and 86400 s, rounded up to the micro-dollar", async () => {
  const want: Record<string, [string, string, string]> = {
    "sealed-1x2": ["0.000292", "0.017500", "0.420000"],
    "sealed-2x4": ["0.000584", "0.035000", "0.840000"],
    "sealed-4x8": ["0.001167", "0.070000", "1.680000"],
    "sealed-8x16": ["0.002334", "0.140000", "3.360000"],
  };
  for (const [size, holds] of Object.entries(want)) {
    for (const [i, life] of [60, 3600, 86400].entries()) {
      const q = await go(["quote", "--size", size, "--lifetime", String(life)]);
      assert.equal(q.r.code, 0, `${size} ${life}`);
      assert.equal(q.r.out.hold_usd, holds[i], `${size} ${life}`);
      assert.equal(q.reqs.length, 1, "read-only: the catalog only");
      assert.equal(q.reqs[0].method, "GET");
    }
  }
  const bad = await go(["quote", "--size", "sealed-9x9", "--lifetime", "60"]);
  assert.equal(bad.r.code, 1);
  const short = await go(["quote", "--size", "sealed-1x2", "--lifetime", "59"]);
  assert.equal(short.r.code, 1);
  assert.equal(short.reqs.length, 0);
});

test("create: checks the account and catalog, posts the exact body with the key, answers running", async () => {
  const x = await go(CREATE(), [createRoute()]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.r.out.ok, true);
  assert.equal(x.r.out.sandbox_id, ID);
  assert.equal(x.r.out.state, "running");
  assert.deepEqual(x.reqs.map((q) => `${q.method} ${q.path}`), ["GET /v1/account", "GET /v1/sandboxes/catalog", "POST /v1/sandboxes"]);
  const p = x.reqs[2];
  assert.equal(p.headers.authorization, `Bearer ${KEY}`);
  assert.equal(p.headers["idempotency-key"], `bitbull-${TASK}-create`);
  assert.equal(p.headers["content-type"], "application/json");
  assert.deepEqual(p.json, {
    required_hardware: "amd_sev_snp",
    template: "sealed-1x2",
    network: "deny_all",
    lifetime_seconds: 300,
    max_spend_usd: "0.010000",
    labels: { bitbull: "1", bitbull_task: TASK },
  });
});

test("create: a 202 in state creating is polled until running", async () => {
  const x = await go(CREATE(), [
    createRoute(() => j(202, sandbox("creating"))),
    ["GET", new RegExp(`^/v1/sandboxes/${ID}$`), seq(() => j(200, sandbox("creating")), () => j(200, sandbox("creating")), () => j(200, sandbox("running")))],
  ]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.r.out.state, "running");
  assert.equal(x.reqs.filter((q) => q.path === `/v1/sandboxes/${ID}`).length, 3);
  assert.deepEqual(x.sleeps, [2000, 2000]);
});

test("create: a sandbox that ends failed is reported with who failed it and that it was not billed", async () => {
  const x = await go(CREATE(), [
    createRoute(() => j(202, sandbox("creating"))),
    ["GET", new RegExp(`^/v1/sandboxes/${ID}$`), once(() => j(200, sandbox("failed", { failed_by: "cathedral", billed: false, error_code: "sealed_capacity_unavailable" })))],
  ]);
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.ok, false);
  assert.equal(x.r.out.error, "sealed_capacity_unavailable");
  assert.equal(x.r.out.failed_by, "cathedral");
  assert.equal(x.r.out.billed, false);
  assert.equal(x.r.out.sandbox_id, ID);
});

test("exec: sync exit 0 succeeds; the request carries the key, the command and the deadline", async () => {
  const x = await go(["exec", ID, "--task", TASK, "--op", "exec1", "--timeout", "30", "--cmd", "uname -a"], [
    ["POST", new RegExp(`^/v1/sandboxes/${ID}/exec$`), once(() => j(200, { exit_code: 0, stdout: "Linux\n", stderr: "", duration_ms: 12, timed_out: false, room_receipt_id: "rr1" }))],
  ]);
  assert.equal(x.r.code, 0);
  assert.equal(x.r.out.ok, true);
  assert.equal(x.r.out.exit_code, 0);
  assert.equal(x.r.out.stdout, "Linux\n");
  assert.equal(x.reqs.length, 1);
  assert.equal(x.reqs[0].headers["idempotency-key"], `bitbull-${TASK}-exec1`);
  assert.deepEqual(x.reqs[0].json, { command: "uname -a", timeout_seconds: 30 });
  const argv = await go(["exec", ID, "--task", TASK, "--op", "exec2", "--", "python3", "-c", "print(1)"], [
    ["POST", new RegExp(`^/v1/sandboxes/${ID}/exec$`), once(() => j(200, { exit_code: 0, stdout: "1\n", stderr: "", timed_out: false }))],
  ]);
  assert.deepEqual(argv.reqs[0].json.command, ["python3", "-c", "print(1)"]);
  assert.equal(argv.reqs[0].json.timeout_seconds, 45, "default deadline");
});

test("exec failures: exit code 1, timed_out true, and a deadline outside 1 to 45 s", async () => {
  const route = (body: any): Route => ["POST", new RegExp(`^/v1/sandboxes/${ID}/exec$`), once(() => j(200, body))];
  const bad = await go(["exec", ID, "--task", TASK, "--op", "e", "--cmd", "false"], [route({ exit_code: 1, stdout: "", stderr: "no\n", timed_out: false })]);
  assert.equal(bad.r.code, 1);
  assert.equal(bad.r.out.ok, false);
  assert.equal(bad.r.out.exit_code, 1);
  assert.equal(bad.r.out.stderr, "no\n");
  const slow = await go(["exec", ID, "--task", TASK, "--op", "e", "--cmd", "sleep 99"], [route({ exit_code: 0, stdout: "", stderr: "", timed_out: true })]);
  assert.equal(slow.r.code, 1);
  assert.equal(slow.r.out.timed_out, true);
  for (const t of ["0", "46", "x"]) {
    const x = await go(["exec", ID, "--task", TASK, "--op", "e", "--timeout", t, "--cmd", "true"]);
    assert.equal(x.r.code, 1, t);
    assert.equal(x.reqs.length, 0, t);
  }
});

test("exec-bg then exec-wait: running, running, exited 0", async () => {
  const start = await go(["exec-bg", ID, "--task", TASK, "--op", "bg1", "--timeout", "1800", "--cmd", "make build"], [
    ["POST", new RegExp(`^/v1/sandboxes/${ID}/execs$`), once(() => j(202, { exec_id: EXEC, state: "running" }))],
  ]);
  assert.equal(start.r.code, 0);
  assert.equal(start.r.out.exec_id, EXEC);
  assert.equal(start.reqs[0].headers["idempotency-key"], `bitbull-${TASK}-bg1`);
  assert.deepEqual(start.reqs[0].json, { command: "make build", timeout_seconds: 1800 });

  const wait = await go(["exec-wait", ID, "--exec", EXEC, "--timeout", "1800"], [
    ["GET", new RegExp(`^/v1/sandboxes/${ID}/execs/${EXEC}$`), seq(() => j(200, { state: "running" }), () => j(200, { state: "running" }), () => j(200, { state: "exited", exit_code: 0, stdout: "ok\n", stderr: "", duration_ms: 5 }))],
  ]);
  assert.equal(wait.r.code, 0, wait.r.stdout);
  assert.equal(wait.r.out.state, "exited");
  assert.equal(wait.r.out.stdout, "ok\n");
  assert.equal(wait.reqs.length, 3);
  for (const q of wait.reqs) assert.equal(q.q.get("wait"), "25");
});

test("exec-bg refuses no timeout and a timeout over 1800; exec-wait: lost is unknown, exit 1 and timed_out are failures", async () => {
  for (const extra of [[], ["--timeout", "1801"], ["--timeout", "0"]]) {
    const x = await go(["exec-bg", ID, "--task", TASK, "--op", "bg", ...extra, "--cmd", "true"]);
    assert.equal(x.r.code, 1);
    assert.equal(x.reqs.length, 0);
  }
  const r = (state: any): Route => ["GET", new RegExp(`^/v1/sandboxes/${ID}/execs/${EXEC}$`), once(() => j(200, state))];
  const lost = await go(["exec-wait", ID, "--exec", EXEC], [r({ state: "lost", failed_by: "cathedral", billed: false, message: "wrapper vanished" })]);
  assert.equal(lost.r.code, 1);
  assert.equal(lost.r.out.ok, false);
  assert.equal(lost.r.out.outcome, "unknown");
  assert.match(lost.r.out.message, /outcome unknown/i);
  const one = await go(["exec-wait", ID, "--exec", EXEC], [r({ state: "exited", exit_code: 1, stdout: "", stderr: "boom" })]);
  assert.equal(one.r.code, 1);
  assert.equal(one.r.out.exit_code, 1);
  const to = await go(["exec-wait", ID, "--exec", EXEC], [r({ state: "timed_out", exit_code: 124 })]);
  assert.equal(to.r.code, 1);
  assert.equal(to.r.out.state, "timed_out");
});

// ---------- cap and hold ----------

test("a hold exactly equal to the limit passes; one micro-dollar over fails", async () => {
  const size2x4 = (rate: string) => SIZES.map((s) => (s.template === "sealed-2x4" ? { ...s, hourly_rate_usd: rate } : s));
  const cat = (rate: string): Route => ["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, catalogBody({}, size2x4(rate))))];
  const args = (spend: string) => ["create", "--task", TASK, "--op", "c", "--size", "sealed-2x4", "--lifetime", "3600", "--max-spend", spend];
  // hold 0.035 = cap 0.035: passes
  const ok = await go(args("0.035"), [cat("0.035"), createRoute()], { CATHEDRAL_MAX_SPEND_USD: "0.035" });
  assert.equal(ok.r.code, 0, ok.r.stdout);
  assert.equal(ok.r.out.spend_limit_usd, "0.035000");
  // hold 0.035001: the amount given (0.035) no longer covers it
  const over = await go(args("0.035"), [cat("0.035001"), createRoute()], { CATHEDRAL_MAX_SPEND_USD: "0.035" });
  assert.equal(over.r.code, 1);
  assert.equal(over.r.out.error, "hold_exceeds_max_spend");
  assert.equal(posts(over.reqs, /sandboxes$/).length, 0);
  // the amount itself one micro-dollar over the limit
  const above = await go(args("0.035001"), [cat("0.035001"), createRoute()], { CATHEDRAL_MAX_SPEND_USD: "0.035" });
  assert.equal(above.r.code, 1);
  assert.equal(above.r.out.error, "max_spend_above_cap");
  assert.equal(above.reqs.length, 0, "the cap check needs no request");
});

test("a capped key uses min(cap, remaining): remaining below the cap binds, cap below remaining binds", async () => {
  const acct = (remaining: string): Route => ["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ api_key: { id: "k", expires_at: null, budget_usd: "5.000000", committed_usd: "0", remaining_usd: remaining } })))];
  const a = (spend: string) => ["create", "--task", TASK, "--op", "c", "--size", "sealed-2x4", "--lifetime", "3600", "--max-spend", spend];
  const low = await go(a("0.050000"), [acct("0.040000"), createRoute()]);
  assert.equal(low.r.out.error, "max_spend_above_remaining");
  assert.equal(low.r.code, 1);
  assert.equal(posts(low.reqs, /sandboxes$/).length, 0);
  const fits = await go(a("0.040000"), [acct("0.040000"), createRoute()]);
  assert.equal(fits.r.code, 0, fits.r.stdout);
  assert.equal(fits.r.out.spend_limit_usd, "0.040000");
  const capLow = await go(a("0.050000"), [acct("4.000000"), createRoute()], { CATHEDRAL_MAX_SPEND_USD: "0.04" });
  assert.equal(capLow.r.out.error, "max_spend_above_cap");
  const capFits = await go(a("0.040000"), [acct("4.000000"), createRoute()], { CATHEDRAL_MAX_SPEND_USD: "0.04" });
  assert.equal(capFits.r.code, 0);
  assert.equal(capFits.r.out.spend_limit_usd, "0.040000");
  // an unset or bad cap setting means 0.50
  const dflt = await go(a("0.500001"), [createRoute()], { CATHEDRAL_MAX_SPEND_USD: "abc" });
  assert.equal(dflt.r.out.error, "max_spend_above_cap");
});

test("an uncapped key is refused with the switch off, and uses the effective cap with it on", async () => {
  const uncapped: Route = ["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ api_key: { id: "k", expires_at: null, budget_usd: null, committed_usd: "0", remaining_usd: null } })))];
  const off = await go(CREATE(), [uncapped, createRoute()]);
  assert.equal(off.r.code, 1);
  assert.equal(off.r.out.error, "uncapped_key_refused");
  assert.equal(posts(off.reqs, /sandboxes$/).length, 0);
  const on = await go(CREATE(), [uncapped, createRoute()], { CATHEDRAL_ALLOW_UNCAPPED_KEY: "on" });
  assert.equal(on.r.code, 0, on.r.stdout);
  assert.equal(on.r.out.spend_limit_usd, "0.500000");
  const onOver = await go(["create", "--task", TASK, "--op", "c", "--size", "sealed-1x2", "--lifetime", "300", "--max-spend", "0.6"], [uncapped, createRoute()], { CATHEDRAL_ALLOW_UNCAPPED_KEY: "on" });
  assert.equal(onOver.r.out.error, "max_spend_above_cap");
  const other = await go(CREATE(), [uncapped, createRoute()], { CATHEDRAL_ALLOW_UNCAPPED_KEY: "yes" });
  assert.equal(other.r.out.error, "uncapped_key_refused", "only the exact value on turns it on");
});

test("a missing or malformed api_key block is an error, never an uncapped key", async () => {
  for (const body of [{ scopes: ["sandboxes:control"] }, acctBody({ api_key: null }), acctBody({ api_key: "oops" }), acctBody({ api_key: { id: "k" } })]) {
    const x = await go(CREATE(), [["GET", /^\/v1\/account$/, once(() => j(200, body))], createRoute()], { CATHEDRAL_ALLOW_UNCAPPED_KEY: "on" });
    assert.equal(x.r.code, 1, JSON.stringify(body));
    assert.equal(x.r.out.error, "account_unreadable");
    assert.equal(posts(x.reqs, /sandboxes$/).length, 0);
  }
});

// ---------- create refused ----------

test("create refused: lifetime 59 and 86401 (no request at all); 60 and 86400 are accepted", async () => {
  for (const life of ["59", "86401", "abc", "60.5"]) {
    const x = await go(["create", "--task", TASK, "--op", "c", "--size", "sealed-1x2", "--lifetime", life, "--max-spend", "0.5"], [createRoute()]);
    assert.equal(x.r.code, 1, life);
    assert.equal(x.r.out.error, "invalid_lifetime");
    assert.equal(x.reqs.length, 0);
  }
  for (const life of ["60", "86400"]) {
    const x = await go(["create", "--task", TASK, "--op", "c", "--size", "sealed-1x2", "--lifetime", life, "--max-spend", "0.5"], [createRoute()]);
    assert.equal(x.r.code, 0, `${life}: ${x.r.stdout}`);
  }
});

test("create refused: unknown size; deny_all not offered; internet not offered; scopes without sandboxes:control", async () => {
  const unknown = await go(CREATE("sealed-9x9"), [createRoute()]);
  assert.equal(unknown.r.out.error, "unknown_size");
  assert.equal(posts(unknown.reqs, /sandboxes$/).length, 0);

  const noDeny = await go(CREATE(), [["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, catalogBody({ network_modes: ["internet"] })))], createRoute()]);
  assert.equal(noDeny.r.code, 1);
  assert.equal(noDeny.r.out.error, "network_mode_not_offered");
  assert.equal(posts(noDeny.reqs, /sandboxes$/).length, 0, "never falls back to a more open mode");
  const noneListed = await go(CREATE(), [["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, { sealed: { available: true, sizes: SIZES } }))], createRoute()]);
  assert.equal(noneListed.r.out.error, "network_mode_not_offered");

  const noNet = await go(CREATE("sealed-1x2", ["--internet"]), [["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, catalogBody({ network_modes: ["deny_all"] })))], createRoute()]);
  assert.equal(noNet.r.out.error, "network_mode_not_offered");

  const scope = await go(CREATE(), [["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ scopes: ["sandboxes:read"] })))], createRoute()]);
  assert.equal(scope.r.code, 1);
  assert.equal(scope.r.out.error, "missing_scope");
  assert.equal(posts(scope.reqs, /sandboxes$/).length, 0);
  const legacy = await go(CREATE(), [["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ scopes: null })))], createRoute()]);
  assert.equal(legacy.r.code, 0, "null scopes mean a legacy full-access key");

  const unavailable = await go(CREATE(), [["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, catalogBody({ available: false, reason: "no_admitted_host" })))], createRoute()]);
  assert.equal(unavailable.r.out.error, "sealed_unavailable");
  assert.match(unavailable.r.out.message, /no_admitted_host/);
});

test("network: --internet sends internet, otherwise deny_all", async () => {
  const a = await go(CREATE("sealed-1x2", ["--internet"]), [createRoute()]);
  assert.equal(posts(a.reqs, /sandboxes$/)[0].json.network, "internet");
  const b = await go(CREATE(), [createRoute()]);
  assert.equal(posts(b.reqs, /sandboxes$/)[0].json.network, "deny_all");
});

// ---------- operation identity ----------

test("every mutating command refuses a missing --task or --op, and names with other characters; no request is made", async () => {
  const cmds = (extra: string[]) => [
    ["create", "--size", "sealed-1x2", "--lifetime", "300", "--max-spend", "0.01", ...extra],
    ["exec", ID, "--cmd", "true", ...extra],
    ["exec-bg", ID, "--timeout", "60", "--cmd", "true", ...extra],
    ["put", ID, "--src", path.join(tmp, "nope"), "--path", "/root/x", ...extra],
    ["delete", ID, ...extra],
  ];
  for (const extra of [[], ["--task", TASK], ["--op", "x"]]) {
    for (const argv of cmds(extra)) {
      const x = await go(argv);
      assert.equal(x.r.code, 1, argv.join(" "));
      assert.equal(x.reqs.length, 0, argv.join(" "));
    }
  }
  const bads: Array<[string, string]> = [["a-b", "c"], ["a", "b-c"], ["ABC", "c"], ["a", "C"], ["a_b", "c"], ["", "c"], ["a".repeat(25), "c"], ["a", "c".repeat(33)], ["a b", "c"]];
  for (const [task, op] of bads) {
    const x = await go(["delete", ID, "--task", task, "--op", op]);
    assert.equal(x.r.code, 1, `${task} ${op}`);
    assert.equal(x.reqs.length, 0);
  }
  const edge = await go(["exec", ID, "--task", "a".repeat(24), "--op", "c".repeat(32), "--cmd", "true"], [["POST", /exec$/, once(() => j(200, { exit_code: 0, stdout: "", stderr: "", timed_out: false }))]]);
  assert.equal(edge.r.code, 0);
  assert.ok(edge.reqs[0].headers["idempotency-key"].length <= 128);
});

test("the idempotency key is bitbull-<task>-<op>; two pairs that would collide with a hyphen are refused or distinct", async () => {
  const k = async (task: string, op: string) => (await go(["exec", ID, "--task", task, "--op", op, "--cmd", "true"], [["POST", /exec$/, once(() => j(200, { exit_code: 0, stdout: "", stderr: "", timed_out: false }))]])).reqs[0]?.headers["idempotency-key"];
  assert.equal(await k("ab", "c"), "bitbull-ab-c");
  assert.equal(await k("a", "bc"), "bitbull-a-bc");
  assert.equal(await k("a-b", "c"), undefined);
  assert.equal(await k("a", "b-c"), undefined);
});

test("a re-run with the same names sends the same key and identical body", async () => {
  const first = await go(CREATE(), [createRoute()]);
  const second = await go(CREATE(), [createRoute()]);
  const [p1] = posts(first.reqs, /sandboxes$/);
  const [p2] = posts(second.reqs, /sandboxes$/);
  assert.equal(p1.headers["idempotency-key"], p2.headers["idempotency-key"]);
  assert.equal(p1.raw!.toString(), p2.raw!.toString());
});

test("resume: a budget change between two runs; with --resume the body is identical, without it the new balance refuses", async () => {
  const acct = (remaining: string): Route => ["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ api_key: { id: "k", expires_at: null, budget_usd: "5.000000", committed_usd: "0", remaining_usd: remaining } })))];
  const first = await go(CREATE(), [acct("4.000000"), createRoute()]);
  assert.equal(first.r.code, 0);
  const resumed = await go(CREATE("sealed-1x2", ["--resume"]), [acct("0.001000"), createRoute()]);
  assert.equal(resumed.r.code, 0, resumed.r.stdout);
  const [a] = posts(first.reqs, /sandboxes$/);
  const [b] = posts(resumed.reqs, /sandboxes$/);
  assert.equal(a.raw!.toString(), b.raw!.toString());
  assert.equal(a.headers["idempotency-key"], b.headers["idempotency-key"]);
  const fresh = await go(CREATE(), [acct("0.001000"), createRoute()]);
  assert.equal(fresh.r.code, 1);
  assert.equal(fresh.r.out.error, "max_spend_above_remaining");
});

test("resume: a catalog rate change between runs leaves the body identical", async () => {
  const rate = (r: string): Route => ["GET", /^\/v1\/sandboxes\/catalog$/, once(() => j(200, catalogBody({}, SIZES.map((s) => (s.template === "sealed-1x2" ? { ...s, hourly_rate_usd: r } : s)))))];
  const first = await go(CREATE(), [rate("0.0175"), createRoute()]);
  const resumed = await go(CREATE("sealed-1x2", ["--resume"]), [rate("0.5"), createRoute()]);
  assert.equal(resumed.r.code, 0, resumed.r.stdout);
  assert.equal(posts(first.reqs, /sandboxes$/)[0].raw!.toString(), posts(resumed.reqs, /sandboxes$/)[0].raw!.toString());
  const fresh = await go(CREATE(), [rate("0.5"), createRoute()]);
  assert.equal(fresh.r.out.error, "hold_exceeds_max_spend");
});

test("resume still enforces the cap and the uncapped-key rule, so a never-used key is a bounded first booking", async () => {
  const over = await go(["create", "--task", TASK, "--op", "c", "--size", "sealed-1x2", "--lifetime", "300", "--max-spend", "0.60", "--resume"], [createRoute()]);
  assert.equal(over.r.code, 1);
  assert.equal(over.r.out.error, "max_spend_above_cap");
  assert.equal(posts(over.reqs, /sandboxes$/).length, 0);
  const uncapped: Route = ["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ api_key: { id: "k", expires_at: null, budget_usd: null, committed_usd: "0", remaining_usd: null } })))];
  const un = await go(CREATE("sealed-1x2", ["--resume"]), [uncapped, createRoute()]);
  assert.equal(un.r.out.error, "uncapped_key_refused");
  assert.equal(posts(un.reqs, /sandboxes$/).length, 0);
  const scope = await go(CREATE("sealed-1x2", ["--resume"]), [["GET", /^\/v1\/account$/, once(() => j(200, acctBody({ scopes: [] })))], createRoute()]);
  assert.equal(scope.r.out.error, "missing_scope");
});

// ---------- retries ----------

const execRoute = (h: Handler): Route => ["POST", new RegExp(`^/v1/sandboxes/${ID}/exec$`), h];
const EXEC_OK = () => j(200, { exit_code: 0, stdout: "done\n", stderr: "", timed_out: false });
const EXEC_ARGS = ["exec", ID, "--task", TASK, "--op", "r1", "--cmd", "echo done"];

test("retries: a 503, a dropped connection and a 409 exec_in_progress are each retried with the same key and body, then succeed", async () => {
  const cases: Array<[string, () => Response | Error, number[]]> = [
    ["503", () => j(503, { detail: { error: "sealed_pool_unavailable", failed_by: "cathedral", billed: false, retry_after_s: 3 } }, { "Retry-After": "3" }), [3000]],
    ["drop", () => dropped(), [1000]],
    ["409", () => j(409, { detail: { error: "exec_in_progress", retry_with_same_key: true, retry_after_s: 5 } }, { "Retry-After": "5" }), [5000]],
  ];
  for (const [name, bad, waits] of cases) {
    const x = await go(EXEC_ARGS, [execRoute(seq(bad as any, EXEC_OK))]);
    assert.equal(x.r.code, 0, `${name}: ${x.r.stdout}`);
    const ps = posts(x.reqs, /exec$/);
    assert.equal(ps.length, 2, name);
    assert.equal(ps[0].headers["idempotency-key"], ps[1].headers["idempotency-key"]);
    assert.equal(ps[0].raw!.toString(), ps[1].raw!.toString());
    assert.deepEqual(x.sleeps, waits, name);
  }
});

test("retries: create, exec-bg and delete retry the same way", async () => {
  const c = await go(CREATE(), [["POST", /^\/v1\/sandboxes$/, seq(() => j(503, { detail: { error: "x", retry_after_s: 1 } }, { "Retry-After": "1" }), () => j(200, sandbox("running")))]]);
  assert.equal(c.r.code, 0);
  assert.equal(posts(c.reqs, /sandboxes$/).length, 2);
  const b = await go(["exec-bg", ID, "--task", TASK, "--op", "b", "--timeout", "60", "--cmd", "true"], [["POST", /execs$/, seq(dropped(), () => j(202, { exec_id: EXEC, state: "running" }))]]);
  assert.equal(b.r.code, 0);
  assert.equal(posts(b.reqs, /execs$/).length, 2);
  const d = await go(["delete", ID, "--task", TASK, "--op", "d"], [
    ["DELETE", new RegExp(`^/v1/sandboxes/${ID}$`), seq(dropped(), () => j(202, sandbox("deleting")))],
    ["GET", new RegExp(`^/v1/sandboxes/${ID}$`), once(() => j(200, sandbox("deleted")))],
    ["GET", new RegExp(`^/v1/sandboxes/${ID}/receipts$`), once(() => j(200, { receipts: [], next_after: null }))],
  ]);
  assert.equal(d.r.code, 0, d.r.stdout);
  assert.equal(d.reqs.filter((q) => q.method === "DELETE").length, 2);
});

test("retries: gives up after 3 retries (4 requests), keeps the same key, and says re-running is safe", async () => {
  const x = await go(EXEC_ARGS, [execRoute(seq(() => j(503, { detail: { error: "sealed_pool_unavailable", retry_after_s: 2 } }, { "Retry-After": "2" })))]);
  assert.equal(posts(x.reqs, /exec$/).length, 4);
  assert.equal(new Set(posts(x.reqs, /exec$/).map((q) => q.headers["idempotency-key"])).size, 1);
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.ok, false);
  assert.equal(x.r.out.status, 503);
  assert.equal(x.r.out.error, "sealed_pool_unavailable");
  assert.equal(x.r.out.retry_with_same_key, true);
  const net = await go(EXEC_ARGS, [execRoute(seq(dropped()))]);
  assert.equal(posts(net.reqs, /exec$/).length, 4);
  assert.equal(net.r.out.error, "network_error");
  assert.equal(net.r.out.retry_with_same_key, true);
});

test("retries: Retry-After is honoured, and a null retry_after_s stops the helper after the first answer", async () => {
  const x = await go(EXEC_ARGS, [execRoute(seq(() => j(503, { detail: { error: "busy" } }, { "Retry-After": "7" }), EXEC_OK))]);
  assert.deepEqual(x.sleeps, [7000]);
  const stop = await go(EXEC_ARGS, [execRoute(seq(() => j(503, { detail: { error: "sandbox_capacity_unavailable", reason: "capacity_full", failed_by: "cathedral", billed: false, retry_after_s: null } })))]);
  assert.equal(posts(stop.reqs, /exec$/).length, 1, "null retry_after_s means do not poll");
  assert.equal(stop.r.code, 1);
  assert.equal(stop.r.out.retry_after_s, null);
  assert.equal(stop.sleeps.length, 0);
  const plain = await go(EXEC_ARGS, [execRoute(seq(() => new Response("Service Unavailable", { status: 503 }), EXEC_OK))]);
  assert.equal(plain.r.code, 0, "a bare 503 with no hint is retried with a short backoff");
  assert.equal(plain.sleeps.length, 1);
});

test("retries: a 502 exec_outcome_unknown (replay_safe false) and a 4xx are not retried", async () => {
  const unknown = await go(EXEC_ARGS, [execRoute(seq(() => j(502, { detail: { error: "exec_outcome_unknown", failed_by: "cathedral", billed: false, replay_safe: false, sandbox_id: ID, retry_after_s: null } })))]);
  assert.equal(posts(unknown.reqs, /exec$/).length, 1);
  assert.equal(unknown.r.out.replay_safe, false);
  assert.equal(unknown.r.out.sandbox_id, ID);
  const bad = await go(EXEC_ARGS, [execRoute(seq(() => j(422, { detail: { error: "invalid_env_vars", message: "no" } })))]);
  assert.equal(posts(bad.reqs, /exec$/).length, 1);
  const reuse = await go(EXEC_ARGS, [execRoute(seq(() => j(409, { detail: { error: "idempotency_key_reused_with_different_request", message: "x" } })))]);
  assert.equal(posts(reuse.reqs, /exec$/).length, 1);
  assert.equal(reuse.r.out.error, "idempotency_key_reused_with_different_request");
  assert.match(reuse.r.out.message, /op name|different/i);
});

test("429 sealed_room_limit_reached is reported with its limit; nothing is deleted and nothing is retried", async () => {
  const x = await go(CREATE(), [createRoute(() => j(429, { detail: { error: "sealed_room_limit_reached", limit: 2, live: 2, failed_by: "you", billed: false, retry_after_s: null } }))]);
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.error, "sealed_room_limit_reached");
  assert.equal(x.r.out.status, 429);
  assert.equal(x.r.out.limit, 2);
  assert.equal(x.r.out.live, 2);
  assert.equal(x.reqs.filter((q) => q.method === "DELETE").length, 0);
  assert.equal(posts(x.reqs, /sandboxes$/).length, 1);
});

// ---------- error shapes ----------

test("error shapes: object, string and list details; top-level metadata; billed missing is unknown", async () => {
  const route = (status: number, body: unknown): Route => execRoute(seq(() => j(status, body)));
  const obj = await go(EXEC_ARGS, [route(422, { detail: { error: "exec_too_long_for_sync", message: "use /execs", failed_by: "you", billed: false, retry_after_s: null } })]);
  assert.deepEqual(
    { ...obj.r.out },
    { ok: false, status: 422, error: "exec_too_long_for_sync", message: "use /execs", failed_by: "you", billed: false, retry_after_s: null, sandbox_id: null, retry_with_same_key: null, replay_safe: null },
  );
  const str = await go(EXEC_ARGS, [route(401, { detail: "Invalid API key" })]);
  assert.equal(str.r.out.status, 401);
  assert.equal(str.r.out.error, "Invalid API key");
  assert.equal(str.r.out.message, "Invalid API key");
  assert.equal(str.r.out.billed, "unknown");
  const list = await go(EXEC_ARGS, [route(422, { detail: [{ type: "missing", loc: ["header", "Idempotency-Key"], msg: "Field required", input: "PRIVATE-INPUT-VALUE" }], failed_by: "you", billed: false, retry_after_s: null })]);
  assert.equal(list.r.out.error, "missing");
  assert.equal(list.r.out.message, "Field required");
  assert.equal(list.r.out.failed_by, "you");
  assert.equal(list.r.out.billed, false);
  assert.equal(list.r.out.retry_after_s, null);
  assert.ok(!list.r.stdout.includes("PRIVATE-INPUT-VALUE"), "a list item's raw input is never copied");
  const top = await go(EXEC_ARGS, [route(422, { detail: { error: "x" }, failed_by: "cathedral", billed: true, sandbox_id: ID, retry_with_same_key: true, replay_safe: true })]);
  assert.equal(top.r.out.failed_by, "cathedral");
  assert.equal(top.r.out.billed, true);
  assert.equal(top.r.out.sandbox_id, ID);
  assert.equal(top.r.out.retry_with_same_key, true);
  assert.equal(top.r.out.replay_safe, true);
  const missing = await go(EXEC_ARGS, [route(422, { detail: { error: "x" } })]);
  assert.equal(missing.r.out.billed, "unknown");
  const header = await go(EXEC_ARGS, [execRoute(seq(() => j(429, { detail: { error: "sandbox_quota_exceeded" } }, { "Retry-After": "30" })))]);
  assert.equal(header.r.out.retry_after_s, 30, "the header fills a missing retry_after_s");
});

// ---------- files ----------

const putArgs = (src: string, op = "putreadme", extra: string[] = []) => ["put", ID, "--task", TASK, "--op", op, "--src", src, "--path", "/root/README.md", ...extra];
const filesRoute = (method: string, h: Handler): Route => [method, new RegExp(`^/v1/sandboxes/${ID}/files$`), h];

test("put: 204 with an empty body succeeds; one request with the key, the content hash and the bytes", async () => {
  const src = path.join(tmp, "readme.txt");
  writeFileSync(src, "hello cathedral\n");
  const x = await go(putArgs(src), [filesRoute("PUT", once(() => empty(204)))]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.r.out.ok, true);
  assert.equal(x.reqs.length, 1);
  const sha = createHash("sha256").update("hello cathedral\n").digest("hex");
  assert.equal(x.r.out.sha256, sha);
  const r = x.reqs[0];
  assert.equal(r.method, "PUT");
  assert.equal(r.q.get("path"), "/root/README.md");
  assert.equal(r.q.get("mode"), "420");
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.headers["idempotency-key"], `bitbull-${TASK}-putreadme-${sha.slice(0, 12)}`);
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.equal(r.raw!.toString(), "hello cathedral\n");
});

test("put: the same bytes reuse the key; changed bytes use a new one", async () => {
  const src = path.join(tmp, "k.txt");
  writeFileSync(src, "one");
  const a = await go(putArgs(src), [filesRoute("PUT", once(() => empty(204)))]);
  const b = await go(putArgs(src), [filesRoute("PUT", once(() => empty(204)))]);
  writeFileSync(src, "two");
  const c = await go(putArgs(src), [filesRoute("PUT", once(() => empty(204)))]);
  assert.equal(a.reqs[0].headers["idempotency-key"], b.reqs[0].headers["idempotency-key"]);
  assert.notEqual(a.reqs[0].headers["idempotency-key"], c.reqs[0].headers["idempotency-key"]);
});

test("put: never retried; a dropped connection and a 503 are one request each and report outcome unknown", async () => {
  const src = path.join(tmp, "once.txt");
  writeFileSync(src, "payload");
  for (const bad of [dropped(), (() => j(503, { detail: { error: "x", retry_after_s: 1 } }, { "Retry-After": "1" })) as () => Response]) {
    const x = await go(putArgs(src), [filesRoute("PUT", seq(bad as any, () => empty(204)))]);
    assert.equal(x.reqs.length, 1);
    assert.equal(x.r.code, 1);
    assert.equal(x.r.out.error, "upload_outcome_unknown");
    assert.match(x.r.out.message, /outcome unknown/i);
    assert.equal(x.sleeps.length, 0);
  }
});

test("put --check: equal bytes read back is landed; a mismatch or a missing path stays outcome unknown with what is there now", async () => {
  const src = path.join(tmp, "check.txt");
  writeFileSync(src, "payload");
  const sha = createHash("sha256").update("payload").digest("hex");
  const landed = await go(putArgs(src, "chk", ["--check"]), [filesRoute("PUT", seq(dropped())), filesRoute("GET", once(() => bin(200, Buffer.from("payload"))))]);
  assert.equal(landed.r.code, 0, landed.r.stdout);
  assert.equal(landed.r.out.landed, true);
  assert.equal(landed.reqs.filter((q) => q.method === "PUT").length, 1);
  assert.equal(landed.reqs.filter((q) => q.method === "GET").length, 1);

  // the upload landed and a later step changed the file: never "not landed"
  const changed = await go(putArgs(src, "chk", ["--check"]), [filesRoute("PUT", seq(dropped())), filesRoute("GET", once(() => bin(200, Buffer.from("changed by another step"))))]);
  assert.equal(changed.r.code, 1);
  assert.equal(changed.r.out.error, "upload_outcome_unknown");
  assert.equal(changed.r.out.observed.sha256, createHash("sha256").update("changed by another step").digest("hex"));
  assert.notEqual(changed.r.out.observed.sha256, sha);
  assert.ok(!/not landed/i.test(changed.r.stdout));

  const absent = await go(putArgs(src, "chk", ["--check"]), [filesRoute("PUT", seq(dropped())), filesRoute("GET", once(() => j(404, { detail: { error: "file_not_found" } })))]);
  assert.equal(absent.r.out.error, "upload_outcome_unknown");
  assert.equal(absent.r.out.observed.absent, true);
  assert.ok(!/not landed/i.test(absent.r.stdout));
});

test("put over 200 MiB is refused before any request; a 413 is reported and stops", async () => {
  const big = path.join(tmp, "big.bin");
  writeFileSync(big, "");
  truncateSync(big, 200 * 1024 * 1024 + 1);
  const x = await go(putArgs(big), [filesRoute("PUT", once(() => empty(204)))]);
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.error, "file_too_large");
  assert.equal(x.reqs.length, 0);
  const edge = path.join(tmp, "edge.bin");
  writeFileSync(edge, "");
  truncateSync(edge, 200 * 1024 * 1024);
  assert.equal((await go(putArgs(edge), [filesRoute("PUT", once(() => empty(204)))])).r.code, 0, "exactly 200 MiB is allowed");

  const src = path.join(tmp, "small.txt");
  writeFileSync(src, "x");
  const r413 = await go(putArgs(src), [filesRoute("PUT", seq(() => j(413, { detail: { error: "file_too_large", message: "too big" } })))]);
  assert.equal(r413.r.code, 1);
  assert.equal(r413.r.out.status, 413);
  assert.equal(r413.r.out.error, "file_too_large");
  assert.equal(r413.reqs.length, 1);
});

test("get: binary content is written byte for byte, with max_bytes on the request", async () => {
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const out = path.join(tmp, "dl.bin");
  const x = await go(["get", ID, "--path", "/root/data.bin", "--out", out], [filesRoute("GET", once(() => bin(200, all)))]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.deepEqual(readFileSync(out), all);
  assert.equal(x.r.out.bytes, 256);
  assert.equal(x.r.out.sha256, createHash("sha256").update(all).digest("hex"));
  assert.equal(x.reqs[0].q.get("path"), "/root/data.bin");
  assert.equal(x.reqs[0].q.get("max_bytes"), String(200 * 1024 * 1024));
  const small = await go(["get", ID, "--path", "/root/data.bin", "--out", out, "--max-bytes", "1024"], [filesRoute("GET", once(() => bin(200, all)))]);
  assert.equal(small.reqs[0].q.get("max_bytes"), "1024");
  const over = await go(["get", ID, "--path", "/root/data.bin", "--out", out, "--max-bytes", String(200 * 1024 * 1024 + 1)], [filesRoute("GET", once(() => bin(200, all)))]);
  assert.equal(over.r.code, 1);
  assert.equal(over.reqs.length, 0);
  const r413 = await go(["get", ID, "--path", "/root/data.bin", "--out", path.join(tmp, "never.bin")], [filesRoute("GET", once(() => j(413, { detail: { error: "file_too_large" } })))]);
  assert.equal(r413.r.code, 1);
  assert.equal(r413.r.out.status, 413);
});

// ---------- receipts, verify, delete, list ----------

const canon = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const mkReceipts = (from: number, to: number) => {
  const out: any[] = [];
  for (let n = from; n <= to; n++) out.push({ n, action: "sandbox.exec", prev_sha256: n === 1 ? null : `p${n - 1}`, sig: "s" });
  return out;
};
const receiptsRoute = (h: Handler): Route => ["GET", new RegExp(`^/v1/sandboxes/${ID}/receipts$`), h];

test("receipts: pages after until next_after is null, prints the count and the head hash", async () => {
  const x = await go(["receipts", ID], [
    receiptsRoute((req) => (req.q.get("after") === "0" ? j(200, { receipts: mkReceipts(1, 3), next_after: 3 }) : j(200, { receipts: mkReceipts(4, 5), next_after: null }))),
  ]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.r.out.count, 5);
  assert.equal(x.r.out.head_n, 5);
  assert.equal(x.r.out.head_sha256, sha256(canon(mkReceipts(5, 5)[0])));
  assert.deepEqual(x.reqs.map((q) => q.q.get("after")), ["0", "3"]);
  assert.equal(x.reqs[0].q.get("limit"), "500");
});

test("receipts: the head hash equals Cathedral's own (Python json.dumps, sort_keys, compact, ensure_ascii)", async () => {
  // Reference computed with Python: hashlib.sha256(json.dumps(d, sort_keys=True,
  // separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")).
  // Everything outside space to tilde is escaped, DEL (0x7f) included.
  const d = { n: 1, lane: "sandbox", note: "caf\u00e9 \u007f \u{1F600}", prev_sha256: null, z: [1, 2] };
  const x = await go(["receipts", ID], [receiptsRoute(() => j(200, { receipts: [d], next_after: null }))]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.r.out.head_sha256, "2ce7678f350b8e963c4c17d0048e9d0ea0316443a69209875b4c9be280045bfa");
});

const verifyRoute = (h: Handler): Route => ["GET", new RegExp(`^/v1/sandboxes/${ID}/receipts/verify$`), h];
const okRoom = (n: number) => ({ event: "exec", sequence: n, status: 200, signature_verified: true, checks: { signature: "ok", amd_report: "not_checked", approved_build: "not_checked" } });

test("verify: two pages of each cursor are aggregated; what was not checked is said plainly", async () => {
  const x = await go(["verify", ID], [
    verifyRoute((req) => {
      const after = req.q.get("after") ?? "0";
      const ro = req.q.get("room_offset") ?? "0";
      const chain = after === "0" ? { verified: false, passed: true, failures: [], from_n: 1, to_n: 1000, next_after: 1000 } : { verified: false, passed: true, failures: [], from_n: 1001, to_n: 1500, next_after: null };
      const room = ro === "0" ? { count: 200, next_offset: 200, receipts: [okRoom(1), okRoom(2)] } : { count: 50, next_offset: null, receipts: [okRoom(3)] };
      return j(200, { chain, room_receipt: { checks: { signature: "ok", amd_report: "not_checked" } }, room_receipts: room });
    }),
  ]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.r.out.ok, true);
  assert.equal(x.reqs.length, 2);
  assert.equal(x.reqs[1].q.get("after"), "1000");
  assert.equal(x.reqs[1].q.get("room_offset"), "200");
  assert.equal(x.r.out.chain.receipts_checked, 1500);
  assert.deepEqual(x.r.out.chain.failures, []);
  assert.equal(x.r.out.room.receipts, 3);
  const notChecked = JSON.stringify(x.r.out.not_checked);
  assert.match(notChecked, /AMD/);
  assert.match(notChecked, /approved build/i);
  assert.match(notChecked, /completeness/i);
});

test("verify: once one cursor ends, its last value is sent while the other goes on", async () => {
  const x = await go(["verify", ID], [
    verifyRoute((req) => {
      const after = req.q.get("after") ?? "0";
      const ro = req.q.get("room_offset") ?? "0";
      const chain = { verified: after === "0", passed: true, failures: [], from_n: 1, to_n: 3, next_after: null };
      const room = ro === "0" ? { count: 200, next_offset: 200, receipts: [okRoom(1)] } : { count: 1, next_offset: null, receipts: [okRoom(2)] };
      return j(200, { chain, room_receipt: null, room_receipts: room });
    }),
  ]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.equal(x.reqs.length, 2);
  assert.equal(x.reqs[1].q.get("after"), "0", "a missing after would start the chain again; the helper keeps its last cursor");
  assert.equal(x.reqs[1].q.get("room_offset"), "200");
});

test("verify: a continuation page with verified false alone is not a failure; a single complete page that is not verified is", async () => {
  const cont = await go(["verify", ID], [
    verifyRoute((req) => (req.q.get("after") ?? "0") === "0"
      ? j(200, { chain: { verified: true, failures: [], from_n: 1, to_n: 10, next_after: 10 }, room_receipts: null })
      : j(200, { chain: { verified: false, passed: true, failures: [], from_n: 11, to_n: 12, next_after: null }, room_receipts: null })),
  ]);
  assert.equal(cont.r.code, 0, cont.r.stdout);
  const lone = await go(["verify", ID], [verifyRoute(() => j(200, { chain: { verified: false, failures: [], from_n: 1, to_n: 3, next_after: null }, room_receipts: null }))]);
  assert.equal(lone.r.code, 1);
});

test("verify: a bad signature and a broken link both fail, and say which receipt", async () => {
  const bad = (check: string) => go(["verify", ID], [verifyRoute(() => j(200, { chain: { verified: false, failures: [{ n: 2, check, reason: `receipt 2 ${check}` }], from_n: 1, to_n: 3, next_after: null }, room_receipt: null, room_receipts: null }))]);
  for (const check of ["signature", "link"]) {
    const x = await bad(check);
    assert.equal(x.r.code, 1, check);
    assert.equal(x.r.out.ok, false);
    assert.equal(x.r.out.chain.failures[0].n, 2);
    assert.equal(x.r.out.chain.failures[0].check, check);
  }
  const room = await go(["verify", ID], [verifyRoute(() => j(200, { chain: { verified: true, failures: [], from_n: 1, to_n: 1, next_after: null }, room_receipt: null, room_receipts: { count: 1, next_offset: null, receipts: [{ ...okRoom(1), signature_verified: false, checks: { signature: "failed" } }] } }))]);
  assert.equal(room.r.code, 1);
});

test("delete: polls until deleted, then fetches the chain again so the head includes the delete receipt", async () => {
  const x = await go(["delete", ID, "--task", TASK, "--op", "del"], [
    ["DELETE", new RegExp(`^/v1/sandboxes/${ID}$`), once(() => j(202, sandbox("deleting")))],
    ["GET", new RegExp(`^/v1/sandboxes/${ID}$`), seq(() => j(200, sandbox("deleting")), () => j(200, sandbox("deleting")), () => j(200, sandbox("deleted")))],
    receiptsRoute(once(() => j(200, { receipts: mkReceipts(1, 4), next_after: null }))),
  ]);
  assert.equal(x.r.code, 0, x.r.stdout);
  assert.deepEqual(x.reqs.map((q) => `${q.method} ${q.path.replace(ID, ":id")}`), [
    "DELETE /v1/sandboxes/:id",
    "GET /v1/sandboxes/:id",
    "GET /v1/sandboxes/:id",
    "GET /v1/sandboxes/:id",
    "GET /v1/sandboxes/:id/receipts",
  ]);
  assert.equal(x.reqs[0].headers["idempotency-key"], `bitbull-${TASK}-del`);
  assert.equal(x.r.out.state, "deleted");
  assert.equal(x.r.out.receipts.count, 4);
  assert.equal(x.r.out.receipts.head_n, 4);
  assert.equal(x.r.out.receipts.head_sha256, sha256(canon(mkReceipts(4, 4)[0])));
  assert.deepEqual(x.sleeps, [2000, 2000]);
});

test("delete: a stuck delete reports the id after the 5 minute limit (counted through sleep)", async () => {
  const x = await go(["delete", ID, "--task", TASK, "--op", "del"], [
    ["DELETE", new RegExp(`^/v1/sandboxes/${ID}$`), once(() => j(202, sandbox("deleting")))],
    ["GET", new RegExp(`^/v1/sandboxes/${ID}$`), seq(() => j(200, sandbox("deleting")))],
  ]);
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.ok, false);
  assert.equal(x.r.out.error, "not_yet_deleted");
  assert.equal(x.r.out.sandbox_id, ID);
  assert.equal(x.sleeps.reduce((a, b) => a + b, 0), 300000);
  assert.equal(x.reqs.filter((q) => q.method === "DELETE").length, 1);
});

test("delete takes one id: no delete-all, no label form", async () => {
  for (const argv of [["delete", "--task", TASK, "--op", "d"], ["delete", "--all", "--task", TASK, "--op", "d"], ["delete", ID, "other", "--task", TASK, "--op", "d"], ["delete", "../x", "--task", TASK, "--op", "d"]]) {
    const x = await go(argv);
    assert.equal(x.r.code, 1, argv.join(" "));
    assert.equal(x.reqs.length, 0);
  }
});

test("list: only bitbull=1 sandboxes, narrowed by task; it never deletes", async () => {
  const route: Route = ["GET", /^\/v1\/sandboxes$/, once(() => j(200, { sandboxes: [sandbox("running", { labels: { bitbull: "1", bitbull_task: TASK }, lifetime_deadline_at: "2026-11-13T12:00:00+00:00" })], has_more: false }))];
  const all = await go(["list"], [route]);
  assert.equal(all.r.code, 0, all.r.stdout);
  assert.deepEqual(all.reqs[0].q.getAll("label"), ["bitbull=1"]);
  assert.equal(all.r.out.sandboxes[0].id, ID);
  const mine = await go(["list", "--task", TASK], [route]);
  assert.deepEqual(mine.reqs[0].q.getAll("label"), ["bitbull=1", `bitbull_task=${TASK}`]);
  assert.ok([...all.reqs, ...mine.reqs].every((q) => q.method === "GET"));
  const bad = await go(["list", "--task", "Bad-Tag"]);
  assert.equal(bad.r.code, 1);
  assert.equal(bad.reqs.length, 0);
});

test("status reads one sandbox", async () => {
  const x = await go(["status", ID], [["GET", new RegExp(`^/v1/sandboxes/${ID}$`), once(() => j(200, sandbox("running", { receipts: { count: 2, head_n: 2, head_sha256: "ab" } })))]]);
  assert.equal(x.r.code, 0);
  assert.equal(x.r.out.state, "running");
  assert.equal(x.r.out.receipts.head_n, 2);
});

test("an unknown command or flag is refused", async () => {
  for (const argv of [["frobnicate"], [], ["catalog", "--bogus", "1"]]) {
    const x = await go(argv);
    assert.equal(x.r.code, 1, argv.join(" "));
    assert.equal(x.r.out.ok, false);
    assert.equal(x.reqs.length, 0);
  }
});

// ---------- the key never leaks ----------

test("key leaks: the API error, a validation item's input and the command's own output all contain the key; it is in none of the helper's output", async () => {
  const leaks: Array<[string, Route, string[]]> = [
    ["error message", execRoute(seq(() => j(422, { detail: { error: "bad", message: `the key ${KEY} was rejected` } }))), EXEC_ARGS],
    ["string detail", execRoute(seq(() => j(401, { detail: `Invalid key ${KEY}` }))), EXEC_ARGS],
    ["validation input", execRoute(seq(() => j(422, { detail: [{ type: "string_type", loc: ["body"], msg: `bad ${KEY}`, input: KEY }] }))), EXEC_ARGS],
    ["command output", execRoute(seq(() => j(200, { exit_code: 0, stdout: `${KEY}\n`, stderr: `err ${KEY}`, timed_out: false }))), EXEC_ARGS],
    ["top-level metadata", execRoute(seq(() => j(422, { detail: { error: "x" }, sandbox_id: KEY, failed_by: KEY }))), EXEC_ARGS],
  ];
  for (const [name, route, argv] of leaks) {
    const x = await go(argv, [route]);
    assert.ok(!x.r.stdout.includes(KEY), `${name}: stdout`);
    assert.equal(x.r.stderr, "", `${name}: stderr`);
    assert.ok(!JSON.stringify(x.r.out).includes(KEY), name);
    assert.deepEqual(JSON.parse(x.r.stdout), x.r.out);
  }
  // a thrown network error that carries the key, and the key in the command line itself
  const thrown = await go(EXEC_ARGS, [execRoute(seq(Object.assign(new Error(`connect to host failed, Authorization: Bearer ${KEY}`), { name: "FetchError" })))]);
  assert.ok(!thrown.r.stdout.includes(KEY));
  assert.equal(thrown.r.stderr, "");
  const echoed = await go(["exec", ID, "--task", TASK, "--op", "e", "--cmd", `echo ${KEY}`], [execRoute(seq(() => j(200, { exit_code: 0, stdout: `${KEY}\n`, stderr: "", timed_out: false })))]);
  assert.ok(!echoed.r.stdout.includes(KEY));
  // a bad path: the error the helper builds itself never carries the key either
  const badPath = await go(["get", ID, "--path", `/root/${KEY}`, "--out", path.join(tmp, "k.out")], [filesRoute("GET", once(() => j(404, { detail: { error: "file_not_found", message: `no file /root/${KEY}` } })))]);
  assert.ok(!badPath.r.stdout.includes(KEY));
});

test("the helper never writes the key to disk: put and get files carry only the bytes", async () => {
  const out = path.join(tmp, "leakcheck.bin");
  await go(["get", ID, "--path", "/root/f", "--out", out], [filesRoute("GET", once(() => bin(200, Buffer.from("plain"))))]);
  assert.equal(readFileSync(out, "utf8"), "plain");
});

test("run never throws: an unexpected failure inside a command comes back as one error object", async () => {
  const x = await go(["catalog"], [["GET", /catalog$/, () => { throw new Error(`boom ${KEY}`); }]]);
  assert.equal(x.r.code, 1);
  assert.equal(x.r.out.ok, false);
  assert.ok(!x.r.stdout.includes(KEY));
});
