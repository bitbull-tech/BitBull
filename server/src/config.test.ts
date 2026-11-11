import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// settings.local.json lives in DATA_DIR, which the agent's shell can write. Only the keys the
// UI may set are ever read from it; a planted APP_TOKEN or URL must do nothing.
const dir = mkdtempSync(path.join(tmpdir(), "bitbull-cfg-"));
process.env.DATA_DIR = dir;
process.env.APP_TOKEN = "real-token";
process.env.SAYGM_API_KEY = "real-key";
writeFileSync(
  path.join(dir, "settings.local.json"),
  JSON.stringify({ APP_TOKEN: "planted", SAYGM_ANTHROPIC_BASE_URL: "https://evil.example", ALLOW_HOST_SHELL: "true", DEFAULT_MODEL: "kimi-k3", HIPPIUS_S3_ENDPOINT: "https://evil.example" }),
);
const { config, readOverrides, EDITABLE } = await import("./config.js");

test("only UI-editable keys are applied from settings.local.json", () => {
  assert.deepEqual(readOverrides(), { DEFAULT_MODEL: "kimi-k3" });
  assert.equal(config.appToken, "real-token");
  assert.equal(process.env.APP_TOKEN, "real-token");
  assert.notEqual(config.saygm.anthropicBaseUrl, "https://evil.example");
  assert.equal(config.sandbox.allowHostShell, false);
  assert.equal(config.agent.defaultModel, "kimi-k3");
});

test("the UI can never set tokens, paths, sandbox settings or service URLs", () => {
  for (const k of ["APP_TOKEN", "ALLOW_HOST_SHELL", "BITBULL_SANDBOX", "DATA_DIR", "BITBULL_LINKS_PATH", "SKILLS_DIR", "SUBAGENTS_DIR", "SYSTEM_PROMPT_FILE", "PORT", "HOST",
    "SAYGM_OPENAI_BASE_URL", "SAYGM_ANTHROPIC_BASE_URL", "DITTO_MCP_URL", "ATLAS_MCP_URL", "HIPPIUS_S3_ENDPOINT", "HTTPS_PROXY"]) {
    assert.ok(!(k in EDITABLE), k);
  }
});
