/**
 * Ditto Router as a second gateway: its models get BitBull ids (`ditto-router/<id>`), and the
 * OpenCode config sends each one to the Router under the Router's own id, on its native API,
 * with the Router key — never SayGM's. Plan mode gets the review endpoint, and the endpoint's
 * tools arrive as MCP servers BitBull attaches itself.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A stand-in Router: the review key sees its own endpoint (memory and tools as `review` says)
let review = { recall_enabled: false, record_enabled: false, tools: [] as string[] };
const router = http.createServer((req, res) => {
  const reviewKey = req.headers.authorization === "Bearer ditto_inf_review";
  const self = reviewKey ? { id: "bitbull-review", ditto: { name: "BitBull review", ...review } } : { id: "bitbull", ditto: { name: "BitBull", recall_enabled: true, record_enabled: true, tools: ["*"] } };
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ ...self, owned_by: "ditto" }] }));
});
await new Promise<void>((r) => router.listen(0, "127.0.0.1", r));
router.unref();

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-router-"));
process.env.SAYGM_API_KEY = "saygm-test-key";
process.env.DITTO_API_KEY = "ditto_mcp_test";
process.env.DITTO_ROUTER_KEY = "ditto_inf_test";
process.env.DITTO_ROUTER_REVIEW_KEY = "ditto_inf_review";
process.env.DITTO_ROUTER_BASE_URL = `http://127.0.0.1:${(router.address() as AddressInfo).port}/v1/`;
process.env.BACKGROUND_VIA = "ditto-router";
process.env.DITTO_ROUTER_MODEL = "z-ai/glm-5.3-flash";
const { fromRouter, routerRefusal } = await import("./models.js");
const { config } = await import("./config.js");
const { parseMcpCatalog, parsePrices, parseRouterModels, priceFor, routerModelId, routerReview } = await import("./router.js");
const { buildConfig, gatewayHint } = await import("./engines/opencode.js");
const base = process.env.DITTO_ROUTER_BASE_URL.replace(/\/$/, "");
await routerReview(true);

type Provider = { npm: string; options: { baseURL: string; apiKey: string; headers?: Record<string, string> }; models: Record<string, unknown> };

test("the endpoint's own entry is named from its ditto block, with what it routes to and records", () => {
  const m = parseRouterModels({
    data: [
      { id: "bitbull", owned_by: "ditto", ditto: { name: "BitBull", model: "openai/gpt-6-luna", record_enabled: true } },
      { id: "anthropic/claude-sonnet-5", owned_by: "anthropic" },
    ],
  });
  const ep = m.find((x) => x.id === "bitbull")!;
  assert.equal(ep.name, "BitBull");
  assert.equal(ep.routesTo, "openai/gpt-6-luna");
  assert.equal(ep.records, true);
  assert.equal(m.find((x) => x.id === "anthropic/claude-sonnet-5")?.name, "anthropic/claude-sonnet-5");
});

test("prices come from Ditto's catalog per token, in $ per million, matched by model name", () => {
  const prices = parsePrices({ models: [{ id: "openai/gpt-6-luna", pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000002" } }, { id: "x", pricing: { prompt: "" } }] });
  assert.deepEqual(prices.get("gpt-6-luna"), { input: 2, output: 8, cacheRead: 0.2 });
  assert.equal(prices.size, 1);
  // the endpoint is priced as the model it routes to
  assert.deepEqual(priceFor({ id: "bitbull", name: "BitBull", routesTo: "openai/gpt-6-luna" }, prices), { input: 2, output: 8, cacheRead: 0.2 });
  assert.equal(fromRouter({ id: "gm/gpt-6-luna", name: "Luna" }, prices).price?.input, 2);
});

test("Router models get prefixed ids and their native API", () => {
  const claude = fromRouter({ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" });
  const glm = fromRouter({ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" });
  assert.equal(claude.id, "ditto-router/anthropic/claude-sonnet-5");
  assert.equal(claude.api, "anthropic");
  assert.equal(glm.api, "chat");
  assert.equal(glm.gateway, "ditto-router");
  assert.equal(routerModelId(glm.id), "z-ai/glm-5.3-flash");
  assert.equal(routerModelId("claude-sonnet-5"), null);
});

test("the MCP catalog: Ditto's built-ins stay \"ditto\", sources get a prefix, odd names and empty servers are left out", () => {
  const servers = parseMcpCatalog(
    {
      clientApprovals: true,
      servers: [
        { name: "ditto", url: "https://router.example/v1/mcp/ditto", tools: [{ name: "search_memories", approval: false }, { name: "notify_me", approval: true }] },
        { name: "github", url: "https://router.example/v1/mcp/github", tools: [{ name: "create_issue", approval: true }] },
        { name: "bad name", url: "https://router.example/v1/mcp/x", tools: [{ name: "t" }] },
        { name: "empty", url: "https://router.example/v1/mcp/empty", tools: [] },
      ],
    },
    "ditto_inf_test",
  );
  assert.deepEqual(servers.map((s) => s.name), ["ditto", "ditto-github"]);
  assert.equal(servers[0].headers.Authorization, "Bearer ditto_inf_test");
  // client approvals: BitBull can't ask mid-turn, so the gated tools are refused
  assert.deepEqual(servers[0].deny, ["notify_me"]);
  assert.deepEqual(parseMcpCatalog({ clientApprovals: false, servers: [{ name: "github", url: "u", tools: [{ name: "a", approval: true }] }] }, "k")[0].deny, []);
  assert.throws(() => parseMcpCatalog({ nope: 1 }, "k"));
});

test("OpenCode sends Router models to the Router: chat key, review key in plan mode", () => {
  const cfg = buildConfig([
    { id: "claude-sonnet-5", name: "Sonnet", family: "anthropic", api: "anthropic" },
    fromRouter({ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }),
    fromRouter({ id: "kimi-k3", name: "Kimi K3" }),
  ]);
  const p = cfg.provider as Record<string, Provider>;
  assert.equal(p["saygm-anthropic"].options.apiKey, "saygm-test-key");
  assert.deepEqual(Object.keys(p["saygm-anthropic"].models), ["claude-sonnet-5"]);
  assert.equal(p["saygm-anthropic"].options.headers, undefined);

  const anthropic = p["ditto-router-anthropic"];
  assert.equal(anthropic.npm, "@ai-sdk/anthropic");
  assert.equal(anthropic.options.baseURL, base);
  assert.equal(anthropic.options.apiKey, "ditto_inf_test");
  assert.deepEqual(Object.keys(anthropic.models), ["anthropic/claude-sonnet-5"]);
  // BitBull's own tools only: the Router adds none of the endpoint's server-side tools
  assert.equal(anthropic.options.headers?.["X-Ditto-Tool-Surface"], "mcp");
  // each chat gets its own Router thread
  assert.ok(cfg.plugin.some((u) => u.endsWith("/ditto-router.js")));

  const chat = p["ditto-router"];
  assert.equal(chat.npm, "@ai-sdk/openai-compatible");
  assert.equal(chat.options.apiKey, "ditto_inf_test");
  // the background model is declared even though the Router's list didn't include it
  assert.deepEqual(Object.keys(chat.models).sort(), ["kimi-k3", "z-ai/glm-5.3-flash"]);
  // housekeeping needs no memory: it runs on the review endpoint
  assert.equal(cfg.small_model, "ditto-router-review/z-ai/glm-5.3-flash");

  // the same models on the review endpoint, for plan mode and QA Hound
  assert.equal(p["ditto-router-review"].options.apiKey, "ditto_inf_review");
  assert.equal(p["ditto-router-review-anthropic"].options.apiKey, "ditto_inf_review");
  assert.deepEqual(Object.keys(p["ditto-router-review"].models).sort(), ["kimi-k3", "z-ai/glm-5.3-flash"]);
});

test("on the review endpoint, the chat endpoint's own entry becomes the review endpoint's", () => {
  const cfg = buildConfig([fromRouter({ id: "bitbull", name: "BitBull", endpoint: true })]);
  const p = cfg.provider as Record<string, Provider>;
  assert.ok(p["ditto-router"].models.bitbull);
  assert.ok(p["ditto-router-review"].models["bitbull-review"]);
  assert.equal(p["ditto-router-review"].models.bitbull, undefined);
});

test("the endpoint's MCP servers replace Ditto's account MCP, with client-approval tools refused", () => {
  const withoutCatalog = buildConfig([]);
  assert.ok((withoutCatalog.mcp as Record<string, unknown>).ditto, "the account MCP when there is no catalog");

  const routerMcp = parseMcpCatalog(
    {
      clientApprovals: true,
      servers: [
        { name: "ditto", url: "https://router.example/v1/mcp/ditto", tools: [{ name: "search_memories" }] },
        { name: "github", url: "https://router.example/v1/mcp/github", tools: [{ name: "create_issue", approval: true }] },
      ],
    },
    "ditto_inf_test",
  );
  const cfg = buildConfig([], routerMcp);
  const mcp = cfg.mcp as Record<string, { url: string; headers: Record<string, string> }>;
  assert.equal(mcp.ditto.url, "https://router.example/v1/mcp/ditto");
  assert.equal(mcp.ditto.headers.Authorization, "Bearer ditto_inf_test");
  assert.equal(mcp["ditto-github"].url, "https://router.example/v1/mcp/github");
  assert.equal((cfg.permission as Record<string, unknown>)["ditto-github_create_issue"], "deny");
});

test("plan mode on a Router model needs a review endpoint with memory and tools off", async () => {
  const m = fromRouter({ id: "kimi-k3", name: "Kimi K3" });
  assert.equal(routerRefusal(m.id, m, true), null);
  review = { recall_enabled: false, record_enabled: true, tools: [] };
  await routerReview(true);
  assert.match(routerRefusal(m.id, m, true)!, /has memory or tools switched on/);
  assert.equal(routerRefusal(m.id, m, false), null);
  review = { recall_enabled: false, record_enabled: false, tools: [] };
  await routerReview(true);
  assert.match(routerRefusal("ditto-router/gone", undefined)!, /isn't on your Ditto Router endpoint/);
  assert.equal(routerRefusal("claude-sonnet-5", undefined, true), null);
  const saved = config.router.reviewKey;
  config.router.reviewKey = "";
  try {
    assert.match(routerRefusal(m.id, m, true)!, /review endpoint/);
    assert.equal(routerRefusal(m.id, m, false), null);
  } finally {
    config.router.reviewKey = saved;
  }
});

test("gateway errors name the gateway that refused", () => {
  assert.match(gatewayHint('{"code":"401"}', "ditto-router/kimi-k3", "ditto-router")!, /Ditto Router rejected the endpoint key/);
  assert.match(gatewayHint('{"code":"401"}', "kimi-k3")!, /SayGM rejected/);
  assert.match(gatewayHint("status 402", "ditto-router/kimi-k3", "ditto-router")!, /spend limit/);
  assert.match(gatewayHint('{"error":{"code":"insufficient_balance"}}', "ditto-router/kimi-k3", "ditto-router")!, /insufficient_balance.*Ditto credits/);
  assert.match(gatewayHint('{"error":{"code":"expired_api_key"}}', "ditto-router/kimi-k3", "ditto-router")!, /expired_api_key/);
});
