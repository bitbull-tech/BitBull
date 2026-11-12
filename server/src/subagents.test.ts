import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLAUDE_READ_ONLY_DISALLOWED, listSubagents, opencodeAgentAccess, parseSubagent, subagentGuide, subagentsSignature } from "./subagents.js";

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
  assert.doesNotMatch(g, /reviewer|challenger/);
  assert.equal(subagentGuide("claude", []), "");
  assert.match(subagentGuide("claude", onlyWorker), /Task\/Agent tool/);
});

test("read-only agents: no shell, no edits, no delegation, on both engines", () => {
  const ro = opencodeAgentAccess({ access: "read" }, { editAllowed: true, shell: true });
  assert.equal(ro.permission.bash, "deny");
  assert.equal(ro.permission.edit, "deny");
  assert.equal(ro.tools?.task, false);
  assert.equal(ro.tools?.bash, false);
  for (const t of ["Bash", "Write", "Edit", "Task", "Agent"]) assert.ok(CLAUDE_READ_ONLY_DISALLOWED.includes(t), t);
});

test("write agents: shell and edits follow the sandbox settings", () => {
  const rw = opencodeAgentAccess({ access: "write" }, { editAllowed: true, shell: true });
  assert.equal(rw.permission.bash, "allow");
  assert.equal(rw.permission.edit, "allow");
  assert.equal(rw.tools, undefined);
  const noShell = opencodeAgentAccess({ access: "write" }, { editAllowed: false, shell: false });
  assert.equal(noShell.permission.bash, "deny");
  assert.equal(noShell.permission.edit, "deny");
});

test("a contract in the front matter becomes the last section of the prompt, and the guide's briefing hint", () => {
  const d = dirWith({
    "r.md": agent(
      "rev",
      "owns: the review, never the fix\ninput: the goal and the diff\noutput: findings ranked by severity\nescalate: a finding needs a product decision\ndone: every changed file is read\n",
    ),
    "plain.md": agent("plain"),
  });
  const [plain, rev] = listSubagents(d);
  assert.deepEqual(rev.contract, {
    owns: "the review, never the fix",
    input: "the goal and the diff",
    output: "findings ranked by severity",
    escalate: "a finding needs a product decision",
    done: "every changed file is read",
  });
  assert.match(rev.prompt, /^You are rev\.\n\n## Your contract\n/);
  assert.match(rev.prompt, /start your report with `ESCALATE:`/);
  // no contract keys: the prompt is the body, unchanged
  assert.equal(plain.prompt, "You are plain.");
  assert.deepEqual(plain.contract, {});
  const g = subagentGuide("opencode", [plain, rev]);
  assert.match(g, /\*\*rev\*\* \(read-only\): does rev things Brief it with: the goal and the diff\. It returns: findings ranked by severity\./);
  assert.match(g, /ESCALATE:/);
  assert.match(g, /TEAM\.md/);
});
