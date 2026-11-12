/**
 * Provider keys through the Ditto CLI: a stand-in `heyditto` (DITTO_CLI) records what BitBull runs
 * it with. The key goes on stdin, never argv; the CLI gets BitBull's Ditto account key and none of
 * BitBull's other secrets; its JSON errors come back with their codes.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "bitbull-heyditto-test-"));
const log = path.join(dir, "calls.jsonl");
const fake = path.join(dir, "heyditto");
writeFileSync(
  fake,
  `#!${process.execPath}
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin, env: process.env }) + "\\n");
  const out = (v, code = 0) => { process.stdout.write(JSON.stringify(v)); process.exit(code); };
  const [, cmd, target] = args;
  if (cmd === "list") return out({ keys: [{ id: "11111111-1111-4111-8111-111111111111", provider: "openrouter", configured: true, enabled: true }] });
  if (cmd === "providers") return out({ providers: [{ id: "gm", displayName: "GM", docsUrl: "https://saygm.com" }] });
  if (cmd === "set" && stdin === "refused-by-ditto") return out({ error: { code: "provider_keys_not_granted", message: "This sign-in can't manage provider keys.", status: 403 } }, 1);
  if (cmd === "set") return out({ key: { id: "k", provider: target, configured: true, enabled: true }, validation: { ok: true, checkedAt: "now" } });
  if (cmd === "enable" || cmd === "disable") return out({ key: { id: target, provider: "openrouter", configured: true, enabled: cmd === "enable" } });
  if (cmd === "remove") return out({ removed: { id: target } });
  process.stderr.write("error: unknown command\\n");
  process.exit(1);
});
`,
);
chmodSync(fake, 0o700);

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-keys-"));
process.env.DITTO_CLI = fake;
process.env.DITTO_API_KEY = "ditto_mcp_account_test";
process.env.SAYGM_API_KEY = "saygm-secret-test";
process.env.APP_TOKEN = "app-token-test";
process.env.HTTPS_PROXY = "http://egress.test:3128";
process.env.NODE_USE_ENV_PROXY = "1";
const keys = await import("./providerKeys.js");

const calls = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string; env: Record<string, string> });

test("a pasted key goes to `heyditto keys set` on stdin, with only the Ditto account key", async () => {
  const saved = await keys.saveProviderKey("openrouter", "  sk-or-v1-pasted  ");
  assert.equal(saved.key.provider, "openrouter");
  assert.equal(saved.validation?.ok, true);
  const call = calls().at(-1)!;
  assert.deepEqual(call.args, ["keys", "set", "openrouter", "--output", "json"]);
  assert.equal(call.stdin, "sk-or-v1-pasted");
  assert.ok(!call.args.join(" ").includes("sk-or-v1"));
  assert.equal(call.env.DITTO_API_KEY, "ditto_mcp_account_test");
  assert.equal(call.env.DITTO_CLI_PINNED, "1");
  assert.equal(call.env.DITTO_CLI_AUTO_UPDATE, "0");
  for (const secret of ["SAYGM_API_KEY", "APP_TOKEN", "DITTO_ROUTER_KEY"]) assert.equal(call.env[secret], undefined, secret);
  // the sandbox's egress proxy, which Node's fetch only uses with NODE_USE_ENV_PROXY
  assert.equal(call.env.HTTPS_PROXY, "http://egress.test:3128");
  assert.equal(call.env.NODE_USE_ENV_PROXY, "1");
  assert.ok(call.env.DITTO_CONFIG_DIR.startsWith(tmpdir()) || call.env.DITTO_CONFIG_DIR.includes("bitbull-heyditto-"));
});

test("BitBull's own SayGM key can be copied to Ditto as the gm key", async () => {
  await keys.copySaygmKey();
  const call = calls().at(-1)!;
  assert.deepEqual(call.args.slice(0, 3), ["keys", "set", "gm"]);
  assert.equal(call.stdin, "saygm-secret-test");
});

test("Ditto's refusals keep their code, and bad input never reaches the CLI", async () => {
  await assert.rejects(keys.saveProviderKey("openrouter", "refused-by-ditto"), (e: unknown) => {
    assert.ok(e instanceof keys.ProviderKeyError);
    assert.equal(e.code, "provider_keys_not_granted");
    assert.equal(e.status, 403);
    return true;
  });
  const before = calls().length;
  await assert.rejects(keys.saveProviderKey("--help", "k"), /Pick a provider/);
  await assert.rejects(keys.saveProviderKey("gm", "   "), /Paste a key/);
  await assert.rejects(keys.removeProviderKey("openrouter; rm -rf /"), /No such key/);
  assert.equal(calls().length, before);
});

test("list, turn off and remove run the matching CLI commands", async () => {
  const { keys: listed } = await keys.listProviderKeys();
  assert.equal(listed[0].provider, "openrouter");
  const id = listed[0].id;
  const off = await keys.setProviderKeyEnabled(id, false);
  assert.equal(off.key.enabled, false);
  await keys.removeProviderKey(id);
  assert.deepEqual(calls().slice(-3).map((c) => c.args.slice(0, 3)), [["keys", "list", "--output"], ["keys", "disable", id], ["keys", "remove", id]]);
  assert.ok(calls().at(-1)!.args.includes("--yes"));
});
