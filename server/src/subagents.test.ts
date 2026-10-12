import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listSubagents, parseSubagent, READ_ONLY_BASH, subagentGuide, subagentsSignature } from "./subagents.js";

const agent = (name: string, extra = "") => `---\nname: ${name}\ndescription: does ${name} things\n${extra}---\nYou are ${name}.\n`;

function dirWith(files: Record<string, string>) {
  const d = mkdtempSync(path.join(tmpdir(), "subagents-"));
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
  return d;
}

test("parses front matter with CRLF, BOM, colons and matching quotes only", () => {
  const p = parseSubagent('﻿---\r\nname: "rev"\r\ndescription: checks: things\r\nmodel: \'gpt-5.5\r\naccess: write\r\n---\r\nBody\r\n');
  assert.ok(p);
  assert.equal(p.fm.name, "rev");
  assert.equal(p.fm.description, "checks: things");
  assert.equal(p.fm.model, "'gpt-5.5"); // unpaired quote kept
  assert.equal(p.body, "Body");
  assert.equal(parseSubagent("no front matter"), null);
});

test("loads, sorts, skips README, accepts .MD and defaults access to read", () => {
  const d = dirWith({ "b.md": agent("beta"), "A.MD": agent("alpha", "access: write\n"), "README.md": agent("readme") });
  const list = listSubagents(d);
  assert.deepEqual(list.map((a) => a.name), ["alpha", "beta"]);
  assert.equal(list[0].access, "write");
  assert.equal(list[1].access, "read");
});

test("a bad entry is skipped instead of crashing", () => {
  const d = dirWith({ "good.md": agent("good"), "nofm.md": "just text", "missing.md": "---\nname: x\n---\nno description" });
  mkdirSync(path.join(d, "drafts.md")); // directory with an .md name
  assert.deepEqual(listSubagents(d).map((a) => a.name), ["good"]);
  assert.deepEqual(listSubagents(path.join(d, "does-not-exist")), []);
});

test("names collide deterministically: first file in sorted order wins", () => {
  const d = dirWith({ "a.md": agent("Test Agent"), "b.md": agent("test-agent") });
  const list = listSubagents(d);
  assert.equal(list.length, 1);
  assert.equal(list[0].description, "does Test Agent things");
});

test("model precedence: SUBAGENT_MODEL_<NAME> beats front matter", () => {
  const d = dirWith({ "r.md": agent("rev-x", "model: claude-x\n") });
  assert.equal(listSubagents(d)[0].model, "claude-x");
  process.env.SUBAGENT_MODEL_REV_X = "gpt-y";
  const d2 = dirWith({ "r.md": agent("rev-x", "model: claude-x\n") });
  assert.equal(listSubagents(d2)[0].model, "gpt-y");
  delete process.env.SUBAGENT_MODEL_REV_X;
});

test("returned list is a copy, and the signature tracks content", () => {
  const d = dirWith({ "a.md": agent("one") });
  const l1 = listSubagents(d);
  l1[0].name = "mutated";
  assert.equal(listSubagents(d)[0].name, "one");
  assert.notEqual(subagentsSignature(listSubagents(d)), subagentsSignature(listSubagents(dirWith({ "a.md": agent("two") }))));
});

test("guide only names habits for agents that exist", () => {
  const onlyWorker = listSubagents(dirWith({ "w.md": agent("worker", "access: write\n") }));
  const g = subagentGuide("opencode", onlyWorker);
  assert.match(g, /worker/);
  assert.doesNotMatch(g, /reviewer|challenger|fact-checker/);
  assert.equal(subagentGuide("claude", []), "");
  assert.match(subagentGuide("claude", onlyWorker), /Task\/Agent tool/);
});

// Mirrors OpenCode's evaluation: wildcard match on the whole command, last matching rule wins.
function bashAllowed(cmd: string) {
  const rx = (p: string) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");
  let action = "ask";
  for (const [p, a] of Object.entries(READ_ONLY_BASH)) if (rx(p).test(cmd)) action = a;
  return action === "allow";
}

test("read-only shell: inspection and tests allowed, writes denied", () => {
  for (const ok of ["git diff --stat", "git log -5", "ls -la", "rg TODO src", "npm test", "npx tsc --noEmit -p .", "pytest -q", "find . -name '*.ts'"])
    assert.ok(bashAllowed(ok), `should allow: ${ok}`);
  for (const no of ["rm -rf src", "sed -i s/a/b/ x.ts", "git checkout main", "git reset --hard", "npm install left-pad", "cat a.ts > b.ts", "echo hi >> x", "find . -name x -delete", "find . -exec rm {} ;", "mv a b", "curl https://x"])
    assert.ok(!bashAllowed(no), `should deny: ${no}`);
});
