import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execCapableConfig, inspectRepo, repoDiffStat } from "./repos.js";

/**
 * A clone is attacker-controlled (the agent clones what it is asked to; an upload can plant a
 * .git folder). Git runs commands named in the repo's own config, as this server process.
 * Confirmed live before the fix: core.fsmonitor on `git status`, and filter.<x>.clean reached
 * through the repo's own .gitattributes.
 */
const ws = mkdtempSync(path.join(tmpdir(), "bitbull-hostile-"));
const marks = path.join(ws, "marks");
mkdirSync(marks);
const env = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" };
const g = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env });

/** A repo whose config runs `touch <marks>/<name>` through the given config stanza. */
function hostile(name: string, stanza: (hit: string) => string, attributes?: string) {
  const dir = path.join(ws, name);
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a");
  if (attributes) writeFileSync(path.join(dir, ".gitattributes"), attributes);
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "first");
  writeFileSync(path.join(dir, "a.txt"), "changed");
  appendFileSync(path.join(dir, ".git", "config"), stanza(path.join(marks, name)));
  return name;
}

const hit = (h: string) => `"touch ${h}; echo"`;
const cases = [
  hostile("fsmonitor", (h) => `[core]\n\tfsmonitor = ${hit(h)}\n`),
  hostile("filterclean", (h) => `[filter "evil"]\n\tclean = ${hit(h)}\n\tsmudge = cat\n`, "a.txt filter=evil\n"),
  hostile("textconv", (h) => `[diff "evil"]\n\ttextconv = ${hit(h)}\n`, "a.txt diff=evil\n"),
  hostile("diffexternal", (h) => `[diff]\n\texternal = ${hit(h)}\n`),
  hostile("pager", (h) => `[core]\n\tpager = ${hit(h)}\n`),
  hostile("alias", (h) => `[alias]\n\tstatus = !${hit(h)}\n`),
];

test("hostile clone: exec-capable config is refused, and nothing runs", async () => {
  for (const name of cases) {
    const found = await execCapableConfig(path.join(ws, name));
    assert.ok(found.length > 0, `${name}: exec-capable key not detected`);

    const info = await inspectRepo(ws, name);
    assert.match(info.error ?? "", /would run as a command/, `${name}: inspected anyway`);
    assert.equal(info.branch, null, `${name}: read repo state despite refusing`);

    const stat = await repoDiffStat(ws, name);
    assert.match(stat, /would run as a command/, `${name}: diffed anyway`);

    assert.equal(existsSync(path.join(marks, name)), false, `${name}: COMMAND EXECUTED — the fix does not hold`);
  }
});

test("the gate fails closed: a repo whose config cannot be read is refused, not trusted", async () => {
  // if the check itself breaks (bad environment, git missing, unreadable config) the repo must
  // be refused — returning "nothing dangerous" would run git in a repo we never vetted
  const missing = path.join(ws, "does-not-exist");
  const found = await execCapableConfig(missing);
  assert.ok(found.length > 0, "an unreadable repo was reported as safe");
  assert.match(found[0], /unreadable config/);
});

test("an ordinary clone still inspects normally", async () => {
  const dir = path.join(ws, "clean");
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "a");
  g(dir, "add", ".");
  g(dir, "commit", "-qm", "first");
  writeFileSync(path.join(dir, "b.txt"), "b");
  const info = await inspectRepo(ws, "clean");
  assert.equal(info.error, undefined);
  assert.equal(info.branch, "main");
  assert.equal(info.untracked, 1);
  assert.ok(info.head?.subject === "first");
  rmSync(ws, { recursive: true, force: true });
});
