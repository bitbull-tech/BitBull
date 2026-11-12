/**
 * Connect Ditto against a stand-in for Ditto's API: sign-in, then BitBull's two endpoints (the
 * chat one created with memory and every tool; an existing review one forced back to no memory
 * and no tools), a key for each, with the default model and background work left on SayGM. It asks for key access (intent "keys")
 * and falls back to a plain login on a Ditto without it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const calls: Array<{ method: string; url: string; auth?: string; body?: Record<string, unknown> }> = [];
const api = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
    const send = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    const route = `${req.method} ${req.url}`;
    // today's Ditto, before the "keys" intent: Connect falls back to a plain login
    if (route === "POST /api/v2/mcp/device-code" && body?.intent === "keys") return send(400, { message: "intent must be one of: login, claude, codex" });
    if (route === "POST /api/v2/mcp/device-code")
      return send(200, { device_code: "dev-1", user_code: "WXYZ-2345", verification_url: "https://app.example/device", expires_in: 600, interval: 1 });
    if (route === "POST /api/v2/mcp/device-token") return send(200, { access_token: "ditto_mcp_account", token_type: "Bearer" });
    if (route === "GET /api/v5/inference/endpoints") return send(200, { endpoints: [{ id: "ep-review", slug: "bitbull-review" }] });
    if (route === "POST /api/v5/inference/endpoints") return send(201, { id: "ep-chat", slug: body.slug });
    if (route === "PATCH /api/v5/inference/endpoints/ep-review") return send(200, { id: "ep-review", slug: "bitbull-review" });
    // a key an earlier Connect from this BitBull made, and someone else's
    if (route === "GET /api/v5/inference/endpoints/ep-review/keys")
      return send(200, { keys: [{ id: "old-1", name: `BitBull on ${hostname()}` }, { id: "theirs", name: "laptop" }, { id: "gone", name: `BitBull on ${hostname()}`, revokedAt: "2026-11-01T00:00:00Z" }] });
    if (route === "DELETE /api/v5/inference/endpoints/ep-review/keys/old-1") return res.writeHead(204).end();
    const key = req.url!.match(/^\/api\/v5\/inference\/endpoints\/([^/]+)\/keys$/);
    if (req.method === "POST" && key) return send(201, { id: "k", key: `ditto_inf_${key[1]}` });
    if (route === "GET /v1/models") return send(200, { object: "list", data: [{ id: "bitbull", owned_by: "ditto", ditto: { name: "BitBull", record_enabled: true } }] });
    if (route === "GET /v1/mcp") return send(200, { endpoint: "bitbull", clientApprovals: false, servers: [] });
    if (route === "GET /saygm/models") return send(200, { data: [] });
    send(404, { message: `no route ${route}` });
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-connect-"));
process.env.SAYGM_API_KEY = "saygm-test-key";
process.env.DITTO_MCP_URL = `${base}/mcp`;
process.env.DITTO_ROUTER_BASE_URL = `${base}/v1`;
process.env.SAYGM_OPENAI_BASE_URL = `${base}/saygm`;
const { connectState, startConnect } = await import("./dittoConnect.js");
const { config } = await import("./config.js");
const { routerRecords } = await import("./router.js");

test("Connect Ditto sets up both endpoints and leaves SayGM as the default", async () => {
  const defaultBefore = config.agent.defaultModel;
  assert.equal(config.router.tools, "off");
  const first = await startConnect();
  assert.equal(first.status, "waiting");
  assert.equal(first.status === "waiting" && first.userCode, "WXYZ-2345");
  const deadline = Date.now() + 15_000;
  while (connectState().status === "waiting" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(connectState(), { status: "connected", endpoint: "bitbull" });

  // the chat endpoint: memory and every tool
  const created = calls.find((c) => c.method === "POST" && c.url === "/api/v5/inference/endpoints")!;
  assert.equal(created.auth, "Bearer ditto_mcp_account");
  assert.deepEqual(created.body, { slug: "bitbull", name: "BitBull", tools: ["*"], recallEnabled: true, recordEnabled: true, billingMode: "both" });
  // asked for key access first, then fell back to a plain login
  assert.deepEqual(calls.filter((c) => c.url === "/api/v2/mcp/device-code").map((c) => c.body?.intent), ["keys", "login"]);
  // the review endpoint already existed: memory and tools forced off again
  const patched = calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patched.body, { name: "BitBull review", tools: [], recallEnabled: false, recordEnabled: false, recordAttachments: false, recordTrace: false });

  assert.equal(config.ditto.apiKey, "ditto_mcp_account");
  assert.equal(config.router.key, "ditto_inf_ep-chat");
  assert.equal(config.router.reviewKey, "ditto_inf_ep-review");
  // a parallel choice: SayGM keeps the default model and background work
  assert.equal(config.agent.defaultModel, defaultBefore);
  assert.equal(config.router.background, "saygm");
  // ready to pick for background work, and the endpoint's tools are on
  assert.equal(config.router.model, "bitbull");
  assert.equal(config.router.tools, "on");
  // the endpoint records its own turns, so BitBull won't archive them again
  assert.equal(routerRecords(), true);
  // only this BitBull's earlier, still-live key is revoked, after the new ones are saved
  assert.deepEqual(calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["/api/v5/inference/endpoints/ep-review/keys/old-1"]);
  api.close();
});
