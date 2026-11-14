import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// links.ts reads BITBULL_LINKS_PATH at import time
const links = mkdtempSync(path.join(tmpdir(), "bitbull-rs-links-"));
process.env.BITBULL_LINKS_PATH = links;
const { addRepo, gitError, inspectRepo, linkedRepos, resolveSource, setRemote, syncRepo } = await import("./repos.js");

const g = (dir: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" } })
    .toString()
    .trim();

// the owner's folder of clones, linked as "github": BitBull (with a GitHub origin) and a non-repo
const mine = path.join(links, "github", "BitBull");
mkdirSync(mine, { recursive: true });
g(mine, "init", "-q", "-b", "main");
writeFileSync(path.join(mine, "a.txt"), "one");
g(mine, "add", ".");
g(mine, "commit", "-qm", "first");
g(mine, "remote", "add", "origin", "https://x-access-token:nope@github.com/bitbull-tech/BitBull.git");
mkdirSync(path.join(links, "github", "notes"));

// a workspace holding a stale copy called BitBob that points at a repository that is gone
const ws = mkdtempSync(path.join(tmpdir(), "bitbull-rs-ws-"));
const stale = path.join(ws, "BitBob");
g(ws, "clone", "-q", mine, "BitBob");
g(stale, "remote", "set-url", "origin", path.join(ws, "gone.git"));
writeFileSync(path.join(stale, "wip.txt"), "uncommitted");

test("lists the repos in linked folders", () => {
  assert.deepEqual(linkedRepos(), [{ ref: "links/github/BitBull", name: "BitBull" }]);
});

test("accepts a linked repo, owner/name and a plain https address; nothing else", () => {
  const l = resolveSource("links/github/BitBull/");
  assert.ok(!("error" in l) && l.kind === "linked" && l.url === mine && l.name === "BitBull");
  const o = resolveSource("bitbull-tech/BitBull");
  assert.ok(!("error" in o) && o.url === "https://github.com/bitbull-tech/BitBull.git" && o.name === "BitBull");
  const u = resolveSource("https://github.com/bitbull-tech/BitBull.git");
  assert.ok(!("error" in u) && u.kind === "url" && u.name === "BitBull");
  for (const bad of [
    "",
    "https://user:tok@github.com/a/b.git",
    "https://tok@github.com/a/b.git",
    "https://github.com/a/b.git?x=1",
    "http://github.com/a/b.git",
    "git@github.com:a/b.git",
    "ssh://git@github.com/a/b.git",
    "file:///etc",
    "/etc",
    "ext::sh -c id",
    "--upload-pack=id",
    "links/github/notes", // not a repo
    "links/github/../../etc",
    "links/nope/x",
  ])
    assert.ok("error" in resolveSource(bad), bad);
});

test("a fetch that fails says why, not the command line", async () => {
  const r = await syncRepo(ws, "BitBob", false);
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, /Command failed|core\.quotepath|-c /);
  assert.match(r.message, /isn't a git repository|not a git repository/);
  assert.match(gitError({ stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/x/y.git/' not found\n" }), /Change remote/);
  assert.match(gitError({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }), /sign-in/);
});

test("change remote: repoints, fetches, follows the branch, renames the folder, leaves work alone", async () => {
  const r = await setRemote(ws, "BitBob", "links/github/BitBull", true);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.path, "BitBull");
  assert.ok(!existsSync(stale));
  const now = path.join(ws, "BitBull");
  assert.equal(g(now, "config", "--get", "remote.origin.url"), mine);
  assert.ok(existsSync(path.join(now, "wip.txt")));
  const info = await inspectRepo(ws, "BitBull");
  assert.equal(info.upstream, "origin/main");
  assert.equal(g(now, "config", "--get", "remote.upstream.url"), "https://github.com/bitbull-tech/BitBull.git");

  // and Sync now follows the owner's folder
  writeFileSync(path.join(mine, "b.txt"), "two");
  g(mine, "add", ".");
  g(mine, "commit", "-qm", "second");
  g(now, "stash", "-u", "-q");
  const s = await syncRepo(ws, "BitBull", false);
  assert.equal(s.ok, true, s.message);
  assert.ok(existsSync(path.join(now, "b.txt")));
});

test("change remote refuses what it shouldn't take, and won't rename over something", async () => {
  assert.equal((await setRemote(ws, "BitBull", "https://tok@github.com/a/b.git")).ok, false);
  assert.equal(g(path.join(ws, "BitBull"), "config", "--get", "remote.origin.url"), mine);
  assert.equal((await setRemote(ws, "../outside", "links/github/BitBull")).ok, false);
});

test("add: a working copy of a linked repo, following it, with its GitHub origin kept as upstream (no token)", async () => {
  const ws2 = mkdtempSync(path.join(tmpdir(), "bitbull-rs-ws2-"));
  const r = await addRepo(ws2, "links/github/BitBull");
  assert.equal(r.ok, true, r.message);
  const dest = path.join(ws2, "BitBull");
  assert.equal(g(dest, "config", "--get", "remote.origin.url"), mine);
  assert.equal(g(dest, "config", "--get", "remote.upstream.url"), "https://github.com/bitbull-tech/BitBull.git");
  assert.doesNotMatch(g(dest, "config", "--list"), /nope/);
  // a second one is refused rather than overwritten
  assert.equal((await addRepo(ws2, "links/github/BitBull")).ok, false);
  // a GitHub address is the agent's job
  assert.equal((await addRepo(ws2, "bitbull-tech/other")).ok, false);
});
