/**
 * ditto_review through BitBull's MCP server: a stand-in `heyditto` (DITTO_CLI) records what the
 * review runs with. It gets the Ditto account key and the egress proxy (with NODE_USE_ENV_PROXY,
 * without which Node's fetch ignores it), never a self-update, and none of BitBull's other secrets.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "bitbull-review-test-"));
const log = path.join(dir, "calls.jsonl");
const fake = path.join(dir, "heyditto");
writeFileSync(
  fake,
  `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + "\\n");
process.stdout.write(JSON.stringify({ findings: [] }));
`,
);
chmodSync(fake, 0o700);

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-review-data-"));
process.env.DITTO_CLI = fake;
process.env.DITTO_API_KEY = "ditto_mcp_account_test";
process.env.DITTO_MCP_URL = "https://api.ditto.test/mcp";
process.env.SAYGM_API_KEY = "saygm-secret-test";
process.env.APP_TOKEN = "app-token-test";
process.env.HTTPS_PROXY = "http://egress.test:3128";
process.env.NODE_USE_ENV_PROXY = "1";
const { paths } = await import("./config.js");
const { handleMcp } = await import("./mcp.js");

const repo = path.join(paths.workspace, "demo");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-q", repo]);

async function callTool(name: string, args: Record<string, unknown>) {
  const res = await handleMcp(
    new Request("http://127.0.0.1/mcp/bitbull", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  assert.ok(body.result, JSON.stringify(body.error));
  return body.result.content[0]!.text;
}

test("ditto_review runs the Ditto CLI with the proxy settings Node needs and no self-update", async () => {
  const out = await callTool("ditto_review", { repo: "demo", mode: "staged", profile: "quick" });
  assert.equal(out, JSON.stringify({ findings: [] }));
  const call = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; env: Record<string, string> }).at(-1)!;
  assert.deepEqual(call.args.slice(0, 3), ["review", "local", "--directory"]);
  assert.ok(call.args.includes("--staged"));
  assert.equal(call.env.DITTO_API_KEY, "ditto_mcp_account_test");
  assert.equal(call.env.DITTO_API_BASE, "https://api.ditto.test");
  assert.equal(call.env.HTTPS_PROXY, "http://egress.test:3128");
  assert.equal(call.env.NODE_USE_ENV_PROXY, "1");
  assert.equal(call.env.DITTO_CLI_AUTO_UPDATE, "0");
  assert.equal(call.env.DITTO_CLI_PINNED, "1");
  // its own HOME and no user/system git config, as before
  assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.ok(call.env.HOME.endsWith(path.join("ditto-cli")));
  assert.ok(call.env.DITTO_CONFIG_DIR.endsWith(path.join("ditto-cli", "config")));
  for (const secret of ["SAYGM_API_KEY", "APP_TOKEN", "DITTO_ROUTER_KEY"]) assert.equal(call.env[secret], undefined, secret);
});
