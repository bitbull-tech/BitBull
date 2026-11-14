/**
 * Cathedral integration, server side: config, vault, settings rows, redaction, engine env,
 * the live probe, the egress allowlist and the skill. The helper itself is in cathedral.test.ts.
 * No test here reaches the network: global fetch is replaced before anything can use it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";

const KEY = "cat_sk_test_dummy_0123456789";
const dir = mkdtempSync(path.join(tmpdir(), "bitbull-cathedral-"));
process.env.DATA_DIR = dir;
process.env.APP_TOKEN = "real-token";
delete process.env.CATHEDRAL_API_KEY;
delete process.env.CATHEDRAL_MAX_SPEND_USD;
delete process.env.CATHEDRAL_ALLOW_UNCAPPED_KEY;
delete process.env.CATHEDRAL_API_URL;

const realFetch = globalThis.fetch;
let stub: (url: string, init?: RequestInit) => Promise<Response> = async () => {
  throw new Error("unexpected network call in a test");
};
const calls: Array<{ url: string; init?: RequestInit }> = [];
globalThis.fetch = (async (url: any, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return stub(String(url), init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const { config, effectiveCathedralCap, reloadConfig } = await import("./config.js");
const { describeSettings, updateSettings } = await import("./settings.js");
const { integrations, probeCathedral, probeIntegrations } = await import("./integrations.js");
const { VAULT_KEYS, lockVault, unlockVault, vaultUnlocked, vaultValues } = await import("./vault.js");
const { redact } = await import("./activity.js");
const { mirrorSkillsInto, listSkills } = await import("./skills.js");
const { cleanEnv } = await import("./engines/claude.js");
const root = path.resolve(import.meta.dirname, "../..");
// loaded by path so the server typecheck does not need to resolve files outside src
const loadOutside = (rel: string): Promise<any> => import(pathToFileURL(path.join(root, rel)).href);
const capMod = await loadOutside("tools/cathedral-cap.mjs");
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// ---- 1. registry ----

test("registry: unconfigured, then configured; the key is in no value the settings or integrations views return", async () => {
  const before = integrations().find((i) => i.id === "cathedral");
  assert.ok(before, "cathedral is in the registry");
  assert.equal(before.configured, false);
  assert.equal(before.global, true);
  assert.equal(before.mcp, undefined);

  await updateSettings({ CATHEDRAL_API_KEY: KEY, CATHEDRAL_MAX_SPEND_USD: "1.5" });
  const after = integrations().find((i) => i.id === "cathedral")!;
  assert.equal(after.configured, true);
  const keyEnv = after.env.find((e) => e.key === "CATHEDRAL_API_KEY")!;
  assert.equal(keyEnv.secret, true, "index.ts masks every env entry flagged secret");

  const rows = describeSettings().find((g) => g.id === "cathedral")!.rows;
  assert.deepEqual(rows.map((r) => r.env), ["CATHEDRAL_API_KEY", "CATHEDRAL_MAX_SPEND_USD", "CATHEDRAL_ALLOW_UNCAPPED_KEY"]);
  const keyRow = rows[0];
  assert.equal(keyRow.secret, true);
  assert.equal(keyRow.hint, "Use a Cathedral key with its own spending cap.");
  assert.ok(rows.every((r) => r.editable));
  assert.deepEqual(rows[2].options, ["off", "on"]);
  assert.match(rows[2].hint ?? "", /no cap of its own/i);
  assert.ok(!JSON.stringify(describeSettings()).includes(KEY));

  // what index.ts sends for /api/integrations: masked unless not secret
  const shown = after.env.map((e) => ({ key: e.key, value: e.secret ? (e.value ? `${e.value.slice(0, 4)}…${e.value.slice(-4)}` : "") : e.value }));
  assert.ok(!JSON.stringify(shown).includes(KEY));

  await updateSettings({ CATHEDRAL_API_KEY: null, CATHEDRAL_MAX_SPEND_USD: null });
  assert.equal(integrations().find((i) => i.id === "cathedral")!.configured, false);
});

// ---- 2. redaction ----

test("redact() masks the key", async () => {
  await updateSettings({ CATHEDRAL_API_KEY: KEY });
  assert.equal(redact(`token ${KEY} end`), "token [REDACTED] end");
  await updateSettings({ CATHEDRAL_API_KEY: null });
});

test("the sandbox guard masks the key in tool output", async () => {
  process.env.CATHEDRAL_API_KEY = KEY;
  const { BitBullGuard } = await loadOutside("agent/opencode-plugin/bitbull-guard.js");
  const hooks = await BitBullGuard();
  const out = { output: `curl said ${KEY}`, title: "t", metadata: {} };
  await hooks["tool.execute.after"]({}, out);
  assert.equal(out.output, "curl said [REDACTED]");
  const env: Record<string, string> = {};
  await hooks["shell.env"]({}, { env });
  assert.equal(env.CATHEDRAL_API_KEY, undefined, "given to the agent on purpose: not blanked");
  delete process.env.CATHEDRAL_API_KEY;
});

// ---- 3. vault ----

test("vault: CATHEDRAL_API_KEY is a vault key; encrypted when unlocked, in settings.local.json when locked (existing behaviour)", async () => {
  assert.ok(VAULT_KEYS.has("CATHEDRAL_API_KEY"));
  assert.ok(!VAULT_KEYS.has("CATHEDRAL_MAX_SPEND_USD"));

  // locked: lands in settings.local.json like every other vault key today
  assert.equal(vaultUnlocked(), false);
  await updateSettings({ CATHEDRAL_API_KEY: KEY });
  const overrides = JSON.parse(readFileSync(path.join(dir, "settings.local.json"), "utf8"));
  assert.equal(overrides.CATHEDRAL_API_KEY, KEY);
  assert.ok(!existsSync(path.join(dir, "vault.json")) || !readFileSync(path.join(dir, "vault.json"), "utf8").includes(KEY));

  // unlocked: encrypted at rest, gone from settings.local.json
  unlockVault("c".repeat(64));
  await updateSettings({ CATHEDRAL_API_KEY: KEY });
  assert.equal(vaultValues().CATHEDRAL_API_KEY, KEY);
  const raw = readFileSync(path.join(dir, "vault.json"), "utf8");
  assert.ok(!raw.includes(KEY) && !raw.includes("CATHEDRAL_API_KEY"));
  const after = JSON.parse(readFileSync(path.join(dir, "settings.local.json"), "utf8"));
  assert.ok(!("CATHEDRAL_API_KEY" in after));

  await updateSettings({ CATHEDRAL_API_KEY: null });
  lockVault();
});

// ---- 4. cap rule ----

test("cap rule: server and helper agree and give the expected number", () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 0.5], ["", 0.5], ["abc", 0.5], ["0", 0.5], ["-1", 0.5], ["0.5", 0.5], ["0.75", 0.75],
    ["25", 25], ["25.01", 0.5], ["100", 0.5],
  ];
  for (const [raw, want] of cases) {
    assert.equal(effectiveCathedralCap(raw), want, `server ${JSON.stringify(raw)}`);
    assert.equal(capMod.effectiveCathedralCap(raw), want, `helper ${JSON.stringify(raw)}`);
  }
  for (const raw of ["1e1", "0x10", " ", "1,5", "NaN", "Infinity", ".5"]) {
    assert.equal(effectiveCathedralCap(raw), capMod.effectiveCathedralCap(raw), raw);
  }
});

// ---- 5. engine environment ----

test("the Claude engine's cleanEnv() has the key after a save and loses it when removed", async () => {
  assert.equal(cleanEnv().CATHEDRAL_API_KEY, undefined);
  await updateSettings({ CATHEDRAL_API_KEY: KEY });
  assert.equal(cleanEnv().CATHEDRAL_API_KEY, KEY);
  await updateSettings({ CATHEDRAL_API_KEY: null });
  assert.equal(cleanEnv().CATHEDRAL_API_KEY, undefined);
});

// ---- 6. probe ----

async function withKey(extra: Record<string, string | null> = {}) {
  await updateSettings({ CATHEDRAL_API_KEY: KEY, ...extra });
}
const account = (over: Record<string, unknown> = {}) => ({
  scopes: ["sandboxes:control"],
  api_key: { id: "k1", expires_at: "2026-12-01T00:00:00+00:00", budget_usd: "5.000000", committed_usd: "1.000000", remaining_usd: "4.000000" },
  ...over,
});
const catalogReady = {
  sealed: { available: true, sizes: [{ template: "sealed-1x2", hourly_rate_usd: "0.0175" }, { template: "sealed-2x4", hourly_rate_usd: "0.035" }] },
};
function serve(acct: () => Response, cat: () => Response) {
  stub = async (url) => (url.endsWith("/v1/account") ? acct() : cat());
}

test("probe: no key means Not configured and no request", async () => {
  calls.length = 0;
  const r = await probeCathedral();
  assert.equal(r.configured, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /Not configured/);
  assert.equal(calls.length, 0);
});

test("probe: the dispatch in probeIntegrations reaches probeCathedral", async () => {
  await withKey();
  calls.length = 0;
  serve(() => json(200, account()), () => json(200, catalogReady));
  const all = await probeIntegrations();
  const c = all.find((x) => x.id === "cathedral")!;
  assert.ok(c, "cathedral is probed");
  assert.equal(c.ok, true);
  assert.ok(calls.some((x) => x.url === "https://cathedral.computer/v1/account"));
  await updateSettings({ CATHEDRAL_API_KEY: null });
});

test("probe: ready shows cap, committed, remaining, expiry, sizes and rates; sends the bearer key to the two routes only", async () => {
  await withKey();
  calls.length = 0;
  serve(() => json(200, account()), () => json(200, catalogReady));
  const r = await probeCathedral();
  assert.equal(r.ok, true);
  assert.match(r.detail, /ready/i);
  assert.match(r.detail, /cap \$5/i);
  assert.match(r.detail, /committed \$1/i);
  assert.match(r.detail, /remaining \$4/i);
  assert.match(r.detail, /2026-12-01/);
  assert.match(r.detail, /sealed-1x2 \$0\.0175\/h/);
  assert.match(r.detail, /sealed-2x4 \$0\.035\/h/);
  assert.deepEqual(calls.map((c) => c.url), ["https://cathedral.computer/v1/account", "https://cathedral.computer/v1/sandboxes/catalog"]);
  for (const c of calls) {
    assert.equal((c.init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    assert.ok(!c.init?.method || c.init.method === "GET");
  }
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test("probe: 401 is key refused; 403 is a permission problem, not refusal", async () => {
  await withKey();
  serve(() => json(401, { detail: "Invalid key" }), () => json(200, catalogReady));
  let r = await probeCathedral();
  assert.equal(r.ok, false);
  assert.match(r.detail, /key refused/i);
  serve(() => json(403, { detail: { error: "insufficient_scope" } }), () => json(200, catalogReady));
  r = await probeCathedral();
  assert.equal(r.ok, false);
  assert.match(r.detail, /may not read its account/i);
  assert.doesNotMatch(r.detail, /refused/i);
});

test("probe: scopes without sandboxes:control are not ready; null scopes are a legacy full-access key", async () => {
  await withKey();
  serve(() => json(200, account({ scopes: ["sandboxes:read"] })), () => json(200, catalogReady));
  let r = await probeCathedral();
  assert.equal(r.ok, false);
  assert.match(r.detail, /this key cannot create sandboxes/i);
  serve(() => json(200, account({ scopes: null })), () => json(200, catalogReady));
  r = await probeCathedral();
  assert.equal(r.ok, true);
  assert.match(r.detail, /ready/i);
});

test("probe: no api_key block or a null budget is red unless the uncapped switch is on, then amber", async () => {
  await withKey();
  const uncapped = account({ api_key: { id: "k1", expires_at: null, budget_usd: null, committed_usd: "0.000000", remaining_usd: null } });
  for (const acct of [uncapped, account({ api_key: null }), { scopes: null }]) {
    serve(() => json(200, acct), () => json(200, catalogReady));
    const r = await probeCathedral();
    assert.equal(r.ok, false);
    assert.equal((r as any).level, "red");
    assert.match(r.detail, /this key has no spending cap; the integration will not create sandboxes/i);
  }
  await updateSettings({ CATHEDRAL_ALLOW_UNCAPPED_KEY: "on" });
  serve(() => json(200, uncapped), () => json(200, catalogReady));
  const r = await probeCathedral();
  assert.equal(r.ok, true);
  assert.equal((r as any).level, "amber");
  assert.match(r.detail, /no spending cap/i);
  assert.match(r.detail, /switch/i);
  await updateSettings({ CATHEDRAL_ALLOW_UNCAPPED_KEY: null });
});

test("probe: sealed unavailable gives its reason as given; sold out for Cathedral's sold-out reasons", async () => {
  await withKey();
  serve(() => json(200, account()), () => json(200, { sealed: { available: false, reason: "no_admitted_host" } }));
  let r = await probeCathedral();
  assert.equal(r.ok, false);
  assert.match(r.detail, /no_admitted_host/);
  assert.doesNotMatch(r.detail, /sold out/i);
  serve(() => json(200, account()), () => json(200, { sealed: { available: false, reason: "not_bound_to_this_account" } }));
  r = await probeCathedral();
  assert.match(r.detail, /not_bound_to_this_account/);
  assert.doesNotMatch(r.detail, /sold out/i);
  for (const reason of ["sealed_capacity_unavailable", "sealed_pool_throttled", "sealed_pool_unavailable", "sealed_pool_unreachable"]) {
    serve(() => json(200, account()), () => json(200, { sealed: { available: false, reason } }));
    r = await probeCathedral();
    assert.match(r.detail, /sold out/i, reason);
    assert.doesNotMatch(r.detail, /unavailable/i, reason);
    assert.equal(r.ok, false);
  }
  serve(() => json(200, account()), () => json(200, {}));
  r = await probeCathedral();
  assert.equal(r.ok, false);
});

test("probe: timeout or network error says Cathedral is not answering, with the error class only", async () => {
  await withKey();
  stub = async () => {
    const e = new Error(`connect failed for ${KEY}`);
    e.name = "TimeoutError";
    throw e;
  };
  const r = await probeCathedral();
  assert.equal(r.ok, false);
  assert.match(r.detail, /Cathedral is not answering/);
  assert.match(r.detail, /TimeoutError/);
  assert.ok(!r.detail.includes(KEY));
  assert.ok(!r.detail.includes("connect failed"));
});

test("probe: refuses a non-https CATHEDRAL_API_URL without sending the key", async () => {
  await withKey();
  process.env.CATHEDRAL_API_URL = "http://cathedral.example";
  reloadConfig();
  calls.length = 0;
  const r = await probeCathedral();
  assert.equal(r.ok, false);
  assert.match(r.detail, /https/);
  assert.equal(calls.length, 0);
  delete process.env.CATHEDRAL_API_URL;
  reloadConfig();
  await updateSettings({ CATHEDRAL_API_KEY: null });
});

test("config: URL is env-only, defaults to cathedral.computer, uncapped switch defaults off", async () => {
  const { EDITABLE } = await import("./config.js");
  assert.ok("CATHEDRAL_API_KEY" in EDITABLE && "CATHEDRAL_MAX_SPEND_USD" in EDITABLE && "CATHEDRAL_ALLOW_UNCAPPED_KEY" in EDITABLE);
  assert.ok(!("CATHEDRAL_API_URL" in EDITABLE));
  assert.equal(config.integrations.cathedral.apiUrl, "https://cathedral.computer");
  assert.equal(config.integrations.cathedral.allowUncapped, false);
});

// ---- 9. allowlist ----

test("allowlist: egress/allowlist.txt has the exact host cathedral.computer", () => {
  const lines = readFileSync(path.join(root, "egress/allowlist.txt"), "utf8").split("\n").map((l) => l.trim());
  assert.ok(lines.includes("cathedral.computer"));
});

// ---- 10. skill ----

test("skill: valid front matter, helper named, mirrored into a workspace by the real mirror function", () => {
  const md = readFileSync(path.join(root, "skills/cathedral-sandbox/SKILL.md"), "utf8");
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "front matter present");
  assert.match(m[1], /^name: cathedral-sandbox$/m);
  assert.match(m[1], /^description: .{20,}$/m);
  assert.ok(listSkills().some((s) => s.dir === "cathedral-sandbox" && s.name === "cathedral-sandbox"));
  assert.match(md, /cathedral\.mjs/);
  assert.doesNotMatch(md, /\u2014/);

  const ws = path.join(dir, "ws");
  assert.deepEqual(mirrorSkillsInto(ws), []);
  const mirrored = path.join(ws, ".claude", "skills", "cathedral-sandbox", "SKILL.md");
  assert.equal(readFileSync(mirrored, "utf8"), md);
  assert.ok(readdirSync(path.join(ws, ".claude", "skills")).includes("cathedral-sandbox"));
});

test("the helper file exists next to the other tools", () => {
  assert.ok(existsSync(path.join(root, "tools/cathedral.mjs")));
});
