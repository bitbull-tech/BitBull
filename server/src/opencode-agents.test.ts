/**
 * Read-only subagents, checked against OpenCode itself rather than our own reading of its
 * config: GM's generated config is handed to the real `opencode` binary, and its resolved
 * agent ("opencode debug agent <name>") must have no shell, no edits and no delegation.
 * Skipped when the binary isn't installed for this platform.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
const dir = mkdtempSync(path.join(tmpdir(), "gm-oc-"));
process.env.DATA_DIR = path.join(dir, "data");
process.env.SAYGM_API_KEY = "test";
process.env.GM_SANDBOX = "docker"; // shell on, as in the container: read agents must still get none
const { buildConfig } = await import("./engines/opencode.js");

function resolved(agent: string) {
  const cfg = buildConfig([{ id: "claude-sonnet-4-5", name: "Sonnet", family: "claude", api: "anthropic" } as never]);
  const out = execFileSync(bin, ["debug", "agent", agent], {
    cwd: dir,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg), HOME: dir, XDG_CONFIG_HOME: path.join(dir, "cfg"), XDG_DATA_HOME: path.join(dir, "share") },
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out.slice(out.indexOf("{"))) as {
    tools: Record<string, boolean>;
    permission: Array<{ permission: string; action: string; pattern: string }>;
  };
}
/** OpenCode's rule: the last matching rule wins. */
const last = (a: ReturnType<typeof resolved>, perm: string) => a.permission.filter((p) => p.permission === perm && p.pattern === "*").at(-1)?.action;

let available = existsSync(bin);
if (available) {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 30_000 });
  } catch {
    available = false;
  }
}

test("OpenCode resolves read-only agents with no shell, edits or delegation", { skip: !available && "opencode binary not available" }, () => {
  for (const name of ["reviewer", "challenger", "fact-checker"]) {
    const a = resolved(name);
    assert.equal(last(a, "bash"), "deny", `${name}: bash`);
    assert.equal(last(a, "edit"), "deny", `${name}: edit`);
    assert.equal(last(a, "task"), "deny", `${name}: task`);
    for (const t of ["bash", "edit", "write", "task"]) assert.equal(a.tools[t], false, `${name}: tool ${t}`);
  }
});

test("OpenCode gives write agents a shell inside the sandbox", { skip: !available && "opencode binary not available" }, () => {
  const a = resolved("worker");
  assert.equal(last(a, "bash"), "allow");
});
