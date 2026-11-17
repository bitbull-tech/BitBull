import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-probe-"));
// not a real key: built here so nothing key-shaped is in the file
const KEY = ["probe", "stand", "in", "value", "0123456789"].join("-");
process.env.SAYGM_API_KEY = KEY;
const { probeModel, verdictOf } = await import("./modelProbe.js");

const answers = (anthropic: [number, unknown, Record<string, string>?], openai: [number, unknown]) => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: { model: string; max_tokens: number } }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) });
    const [status, body, headers] = u.endsWith("/v1/messages") ? anthropic : [...openai, undefined];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { f, seen };
};
const cooling = { error: { type: "model_cooling", message: "claude-opus-5-5 is temporarily unable to serve this request. Retry after 60s." } };

test("two plain requests with BitBull's key, and the key never comes back", async () => {
  const { f, seen } = answers([429, { error: { type: "model_cooling", message: `no capacity for key ${KEY}` } }, { "retry-after": "60" }], [200, { choices: [] }]);
  const r = await probeModel("claude-opus-5-5", f);
  assert.ok(!("error" in r));
  assert.equal(seen.length, 2);
  const a = seen.find((s) => s.url.endsWith("/v1/messages"))!;
  assert.equal(a.headers["x-api-key"], KEY);
  assert.equal(a.body.model, "claude-opus-5-5");
  assert.ok(a.body.max_tokens <= 16);
  assert.equal(seen.find((s) => s.url.endsWith("/chat/completions"))!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.legs[0].status, 429);
  assert.equal(r.legs[0].retryAfter, "60");
  assert.match(r.legs[0].message!, /model_cooling/);
  assert.ok(!JSON.stringify(r).includes(KEY), "the key is not in the result");
  assert.equal(r.side, "gateway");
  assert.match(r.verdict, /OpenCode engine/);
});

test("the verdict says whose problem it is", async () => {
  const run = async (a: [number, unknown], o: [number, unknown]) => {
    const r = await probeModel("m", answers(a, o).f);
    assert.ok(!("error" in r));
    return r;
  };
  assert.equal((await run([429, cooling], [429, cooling])).side, "gateway");
  assert.match((await run([429, cooling], [429, cooling])).verdict, /not BitBull/);
  assert.equal((await run([200, {}], [200, {}])).side, "bitbull");
  assert.equal((await run([401, { error: "bad key" }], [401, { error: "bad key" }])).side, "key");
  const half = await run([401, { error: { message: "invalid x-api-key" } }], [200, {}]);
  assert.equal(half.side, "key");
  assert.match(half.verdict, /SAYGM_ANTHROPIC_AUTH to bearer/);
  assert.equal((await run([500, "upstream exploded"], [500, "upstream exploded"])).side, "unclear");
  assert.equal((await run([500, "upstream exploded"], [500, "x"])).legs[0].message, "upstream exploded");
});

test("no network, no key, and Router models are said plainly", async () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const r = await probeModel("m", down);
  assert.ok(!("error" in r));
  assert.equal(r.side, "network");
  assert.equal(r.legs[0].status, null);
  assert.ok("error" in (await probeModel("ditto-router/some-model", down)));
  assert.ok("error" in (await probeModel("", down)));
  const none = { door: "anthropic" as const, url: "", status: null, ok: false, ms: 1 };
  assert.equal(verdictOf(none, { ...none, door: "openai" }).side, "network");
});
