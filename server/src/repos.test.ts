import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { findRepos, inspectRepo, listRepos, repoDiffStat } from "./repos.js";

const ws = mkdtempSync(path.join(tmpdir(), "gm-repos-"));
const g = (dir: string, ...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" } });

// origin (bare) + a clone with a branch, an unpushed commit, a dirty file and an untracked file
const origin = path.join(ws, "origin.git");
mkdirSync(origin);
g(origin, "init", "--bare", "-q", "-b", "main");
const seed = mkdtempSync(path.join(tmpdir(), "gm-seed-"));
g(seed, "init", "-q", "-b", "main");
writeFileSync(path.join(seed, "a.txt"), "a");
g(seed, "add", ".");
g(seed, "commit", "-qm", "first");
g(seed, "remote", "add", "origin", origin);
g(seed, "push", "-q", "origin", "main");
mkdirSync(path.join(ws, "code"));
g(path.join(ws, "code"), "clone", "-q", origin, "thing");
const clone = path.join(ws, "code", "thing");
g(clone, "checkout", "-qb", "feat/x");
writeFileSync(path.join(clone, "b.txt"), "b");
g(clone, "add", "b.txt");
g(clone, "commit", "-qm", "add b");
writeFileSync(path.join(clone, "a.txt"), "changed");
writeFileSync(path.join(clone, "new.txt"), "n");
mkdirSync(path.join(ws, "node_modules", "pkg"), { recursive: true });
g(path.join(ws, "node_modules", "pkg"), "init", "-q");
mkdirSync(path.join(ws, "notes"));
writeFileSync(path.join(ws, "notes", "x.md"), "x");

test("finds clones but skips dependency folders", () => {
  assert.deepEqual(findRepos(ws), ["code/thing"]);
});

test("reports branch, upstream, ahead count, dirty and untracked files", async () => {
  const r = await inspectRepo(ws, "code/thing");
  assert.equal(r.error, undefined);
  assert.equal(r.name, "thing");
  assert.equal(r.branch, "feat/x");
  assert.equal(r.changed, 1);
  assert.equal(r.untracked, 1);
  assert.equal(r.head?.subject, "add b");
  assert.ok(r.remote?.endsWith("origin.git"));
  const names = r.branches.map((b) => b.name);
  assert.ok(names.includes("feat/x") && names.includes("main") && names.includes("origin/main"), names.join());
  assert.ok(r.branches.find((b) => b.name === "origin/main")?.remote);
  assert.equal(r.branches.find((b) => b.name === "feat/x")?.current, true);
});

test("credentials in a remote URL are never shown", async () => {
  g(clone, "remote", "set-url", "origin", "https://user:s3cret@example.com/x.git");
  const r = await inspectRepo(ws, "code/thing");
  assert.equal(r.remote, "https://example.com/x.git");
});

test("diff stat is read-only and refuses odd refs", async () => {
  const d = await repoDiffStat(ws, "code/thing");
  assert.match(d, /a\.txt/);
  const bad = await repoDiffStat(ws, "code/thing", "--output=/tmp/x");
  assert.doesNotMatch(bad, /output/);
  assert.deepEqual((await listRepos(ws)).map((r) => r.path), ["code/thing"]);
});
