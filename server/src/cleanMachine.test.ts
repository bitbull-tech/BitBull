/**
 * The clean-machine test and the reviewers' sealed room, driven with a fake Cathedral (injected
 * helper / createRoom / deleteRoom): nothing here reaches the network or needs a key.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(path.join(tmpdir(), "bitbull-clean-"));
process.env.DATA_DIR = path.join(root, "data");
after(() => rmSync(root, { recursive: true, force: true }));

const { runCleanMachine, openReviewRoom, closeReviewRoom, renderCertificate, stripCredentials, snapshotTarget, taskTag } = await import("./cleanMachine.js");
type CathedralDeps = import("./cleanMachine.js").CathedralDeps;
type CreateArgs = import("./cleanMachine.js").CreateArgs;

const ws = path.join(root, "ws");
const repo = path.join(ws, "app");
mkdirSync(path.join(repo, "src"), { recursive: true });
const g = (dir: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x", GIT_CONFIG_GLOBAL: "/dev/null" } })
    .toString()
    .trim();
g(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "src", "app.py"), "print('hi')\n");
writeFileSync(path.join(repo, "README.md"), "# app\n");
g(repo, "add", ".");
g(repo, "commit", "-qm", "first");
g(repo, "remote", "add", "origin", "https://user:ghp_secret@github.com/acme/app.git");
const COMMIT = g(repo, "rev-parse", "HEAD");
// a folder that is not in a repo, with things a snapshot must leave out
const loose = path.join(ws, "loose");
mkdirSync(path.join(loose, "sub"), { recursive: true });
writeFileSync(path.join(loose, "main.py"), "x = 1\n");
writeFileSync(path.join(loose, ".env"), "KEY=nope\n");
writeFileSync(path.join(loose, ".env.example"), "KEY=\n");
writeFileSync(path.join(loose, "sub", "deep.txt"), "deep\n");
symlinkSync("/etc/passwd", path.join(loose, "link"));

const SID = "7a5992ea-9e2e-46f9-81b0-0f94cf62ec70";
const RUN = "0b6f1d2e-3c4a-4b5c-8d9e-0f1a2b3c4d5e";
const DIGEST = "sha256:" + "ab".repeat(32);
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

interface Fake {
  deps: CathedralDeps;
  calls: string[][];
  creates: CreateArgs[];
  deletes: string[];
  logs: string[];
}

/** A fake Cathedral: exits[op] is the exit code for that step (default 0). */
function fake(opts: { deny?: boolean; exits?: Record<string, number>; putFails?: boolean; throwOn?: string } = {}): Fake {
  const f: Fake = { calls: [], creates: [], deletes: [], logs: [], deps: undefined as unknown as CathedralDeps };
  f.deps = {
    async helper(argv) {
      f.calls.push(argv);
      const [cmd] = argv;
      if (opts.throwOn === cmd) throw new Error(`boom in ${cmd}`);
      const flag = (n: string) => argv[argv.indexOf(`--${n}`) + 1];
      switch (cmd) {
        case "put":
          return { code: opts.putFails ? 1 : 0, out: opts.putFails ? { ok: false, error: "upload_failed" } : { ok: true, bytes: 10, sha256: "f".repeat(64) } };
        case "exec":
          return { code: 0, out: { ok: true, exit_code: 0, stdout: "", stderr: "" } };
        case "exec-bg":
          return { code: 0, out: { ok: true, exec_id: `e-${flag("op")}`, state: "running" } };
        case "exec-wait": {
          const op = flag("exec").slice(2);
          const code = Object.entries(opts.exits ?? {}).find(([k]) => op.endsWith(k))?.[1] ?? 0;
          return {
            code: 0,
            out: { ok: code === 0, state: "exited", exit_code: code, stdout: `out of ${op}\n`, stderr: code ? "it broke\n" : "", started_at: "2026-11-16T10:00:00Z", finished_at: "2026-11-16T10:01:00Z", duration_ms: 60000, stdout_truncated: false, stderr_truncated: false, room_receipt_id: `rr-${op}` },
          };
        }
        case "status": {
          // after the delete Cathedral reports the head that includes the delete receipt
          const head = f.deletes.length ? { count: 7, head_n: 7, head_sha256: "2".repeat(64) } : { count: 6, head_n: 6, head_sha256: "1".repeat(64) };
          return { code: 0, out: { ok: true, image: "python:3.12-slim", image_digest: DIGEST, receipt_id: "rc-create", receipt_url: "/v1/receipts/rc-create", receipts: head } };
        }
        case "verify":
          return { code: 0, out: { ok: true, checked: ["chain links"], not_checked: ["the AMD SEV-SNP report and AMD's certificate chain (needs the offline verifier)", "that no receipts were cut from the end of the chain"] } };
        case "evidence":
          writeFileSync(flag("out"), JSON.stringify({ schema: "cathedral_sandbox_evidence_v1" }));
          return { code: 0, out: { ok: true, bytes: 40, sha256: "e".repeat(64), schema: "cathedral_sandbox_evidence_v1" } };
        default:
          return { code: 2, out: { ok: false, error: "unknown" } };
      }
    },
    async createRoom(i) {
      f.creates.push(i);
      if (opts.deny) return { ok: false, error: "denied", message: "The owner said no. Nothing was created." };
      return { ok: true, sandbox_id: SID, image: "python:3.12-slim", image_digest: DIGEST, receipt_id: "rc-create", receipt_url: "/v1/receipts/rc-create", created_at: "2026-11-16T09:59:00Z", hotel: "h1", max_spend_usd: "0.04" };
    },
    async deleteRoom(id) {
      f.deletes.push(id);
      return { ok: true, receipts: { count: 7, head_n: 7, head_sha256: "2".repeat(64) } };
    },
    apiUrl: () => "https://cathedral.computer",
    log: (_l, m) => f.logs.push(m),
  };
  return f;
}

const opts = (o: Partial<{ install: string; build: string; test: string; allowHosts: string[] }> = {}) => ({
  enabled: true,
  install: "pip install -r requirements.txt",
  build: "python -m compileall src",
  test: "python -m pytest -q",
  allowHosts: [] as string[],
  size: "sealed-2x4",
  ...o,
});
const input = (o = opts(), target = "app") => ({ runId: RUN, projectId: "p1", sessionId: "s1", ws, target, options: o, deadline: Date.now() + 30 * 60_000 });

test("happy path: a certificate with the commit, commands, hashes, room, receipts, verify; saved with the evidence", async () => {
  const f = fake();
  const r = await runCleanMachine(input(opts({ allowHosts: ["pypi.org", "files.pythonhosted.org"] })), f.deps);
  assert.ok(r.ok, r.error ?? "");
  const c = r.certificate!;
  assert.equal(c.result, "pass");
  assert.equal(c.repo.commit, COMMIT);
  assert.equal(c.repo.path, "app");
  assert.equal(c.repo.remote, "https://github.com/acme/app.git", "credentials stripped from the remote");
  assert.deepEqual(c.commands.map((x) => [x.step, x.exitCode, x.ok]), [["install", 0, true], ["build", 0, true], ["test", 0, true]]);
  assert.equal(c.commands[0].stdoutSha256, sha("out of step1install\n"));
  assert.equal(c.commands[0].stderrSha256, sha(""));
  assert.equal(c.commands[2].roomReceiptId, "rr-step3test");
  assert.equal(c.room.imageDigest, DIGEST);
  assert.equal(c.room.image, "python:3.12-slim");
  assert.equal(c.room.size, "sealed-2x4");
  assert.equal(c.room.createReceiptUrl, "https://cathedral.computer/v1/receipts/rc-create");
  assert.equal(c.room.attestationUrl, "https://cathedral.computer/v1/hotels/h1/attestation");
  assert.deepEqual(c.receiptHead, { count: 7, n: 7, sha256: "2".repeat(64), from: "delete" }, "head from the delete");
  assert.equal(c.verify.ok, true);
  assert.equal(c.verify.notChecked.length, 2);
  assert.ok(c.deleted);
  // files: JSON, MD and the evidence bundle, in the workspace
  assert.deepEqual(c.files, { json: `.bitbull/certificates/${RUN}.json`, md: `.bitbull/certificates/${RUN}.md` });
  assert.equal(c.evidence.path, `.bitbull/certificates/${RUN}.evidence.json`);
  assert.ok(existsSync(path.join(ws, c.evidence.path!)));
  assert.equal(JSON.parse(readFileSync(path.join(ws, c.files!.json), "utf8")).repo.commit, COMMIT);
  // the order: upload, unpack, the commands in order, then status, verify, evidence; delete last
  const cmds = f.calls.map((a) => a[0]);
  assert.deepEqual(cmds, ["put", "exec", "exec-bg", "exec-wait", "exec-bg", "exec-wait", "exec-bg", "exec-wait", "status", "verify", "evidence", "status"]);
  const bg = f.calls.filter((a) => a[0] === "exec-bg");
  assert.deepEqual(bg.map((a) => a[a.indexOf("--cmd") + 1]), [opts().install, opts().build, opts().test]);
  assert.ok(bg.every((a) => a[a.indexOf("--cwd") + 1] === "/work/src" && Number(a[a.indexOf("--timeout") + 1]) <= 1800));
  assert.deepEqual(f.deletes, [SID]);
  assert.ok(f.logs.some((l) => /certificate .*PASS/.test(l)));
  // request 5: the upload itself is logged with what, where, size and hash
  assert.ok(f.logs.some((l) => /sent git archive of .* to sealed room .*: \/work\/src\.tar \(\d+ bytes, sha256 [0-9a-f]{64}\)/.test(l)), f.logs.join("\n"));
  assert.ok(r.certificate!.commands.every((c) => c.state === "not_run" || /^[0-9a-f]{64}$/.test(c.commandSha256 ?? "")));
});

test("allowHosts are passed through, never internet; empty means closed", async () => {
  const f = fake();
  await runCleanMachine(input(opts({ allowHosts: ["registry.npmjs.org"] })), f.deps);
  assert.equal(f.creates[0].internet, false);
  assert.deepEqual(f.creates[0].allowHosts, ["registry.npmjs.org"]);
  assert.equal(f.creates[0].purpose, "clean-machine");
  assert.match(f.creates[0].op, /^[a-z0-9]+$/);
  assert.match(f.creates[0].task!, /^[a-z0-9]{1,24}$/);
  const g2 = fake();
  const r = await runCleanMachine(input(), g2.deps);
  assert.equal(g2.creates[0].internet, false);
  assert.equal(g2.creates[0].allowHosts, undefined);
  assert.equal(r.certificate!.room.network, "closed");
});

test("a failing build stops the commands after it", async () => {
  const f = fake({ exits: { build: 2 } });
  const r = await runCleanMachine(input(), f.deps);
  const c = r.certificate!;
  assert.equal(c.result, "fail");
  assert.deepEqual(c.commands.map((x) => x.state), ["exited", "failed", "not_run"]);
  assert.equal(c.commands[1].exitCode, 2);
  assert.match(c.commands[2].note!, /not run/);
  assert.equal(f.calls.filter((a) => a[0] === "exec-bg").length, 2);
  assert.deepEqual(f.deletes, [SID], "still deleted");
  assert.ok(f.calls.some((a) => a[0] === "verify"), "still verified");
});

test("the owner says no: no room, nothing uploaded, a clear error", async () => {
  const f = fake({ deny: true });
  const r = await runCleanMachine(input(), f.deps);
  assert.equal(r.ok, false);
  assert.match(r.error!, /owner said no/);
  assert.equal(r.certificate, undefined);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.deletes, []);
});

test("a target outside a git repo is refused before anything is created", async () => {
  const f = fake();
  const r = await runCleanMachine(input(opts(), "loose"), f.deps);
  assert.equal(r.ok, false);
  assert.match(r.error!, /not in a git repo/);
  assert.equal(f.creates.length, 0);
});

test("the room is deleted when something fails part way, and the certificate says so", async () => {
  const f = fake({ putFails: true });
  const r = await runCleanMachine(input(), f.deps);
  assert.deepEqual(f.deletes, [SID]);
  assert.equal(r.certificate!.result, "incomplete");
  assert.match(r.certificate!.failure!, /upload failed/);
  const h = fake({ throwOn: "verify" });
  const r2 = await runCleanMachine(input(), h.deps);
  assert.deepEqual(h.deletes, [SID], "deleted after a throw too");
  assert.match(r2.certificate!.failure!, /boom in verify/);
});

test("the Markdown says what it does not show, verbatim from verify, and never 'Cathedral-signed'", async () => {
  const f = fake();
  const r = await runCleanMachine(input(), f.deps);
  const md = r.markdown!;
  assert.match(md, /## What this shows/);
  assert.match(md, /## What this does not show/);
  assert.match(md, /That the code is safe or correct/);
  assert.ok(md.includes("  - that no receipts were cut from the end of the chain"));
  assert.ok(md.includes("ctcli receipt verify --bundle evidence.json --cathedral-key"));
  assert.ok(md.includes("approved-measurements.json"));
  assert.ok(md.includes(COMMIT));
  assert.ok(!/cathedral-signed/i.test(md));
  assert.ok(!md.includes(String.fromCharCode(0x2014)), "no em dashes");
  assert.equal(readFileSync(path.join(ws, r.certificate!.files!.md), "utf8"), md);
  assert.ok(!/cathedral-signed/i.test(renderCertificate({ ...r.certificate!, result: "fail" })));
});

test("a link planted at .bitbull is not written through", async () => {
  const ws2 = path.join(root, "ws2");
  mkdirSync(ws2);
  execFileSync("cp", ["-r", repo, path.join(ws2, "app")]);
  const elsewhere = path.join(root, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(ws2, ".bitbull"));
  const f = fake();
  const r = await runCleanMachine({ ...input(), ws: ws2 }, f.deps);
  assert.equal(r.ok, false);
  assert.match(r.error!, /not a plain folder/);
  assert.equal(f.creates.length, 0);
});

test("credentials come out of remote URLs", () => {
  assert.equal(stripCredentials("https://x-access-token:abc@github.com/a/b.git"), "https://github.com/a/b.git");
  assert.equal(stripCredentials("git@github.com:a/b.git"), "git@github.com:a/b.git");
  assert.equal(taskTag("c", RUN).length <= 24, true);
  assert.notEqual(taskTag("c", RUN), taskTag("h", RUN));
});

test("snapshots: the commit of a repo path; a folder without .git, .env or links", async () => {
  const s1 = await snapshotTarget(ws, "app/src");
  assert.ok(!("error" in s1));
  if ("error" in s1) return;
  assert.equal(s1.source.kind, "git");
  assert.ok(s1.source.kind === "git" && s1.source.commit === COMMIT && s1.source.path === "src");
  assert.deepEqual(execFileSync("tar", ["-tf", s1.file]).toString().trim().split("\n"), ["app.py"]);
  s1.cleanup();
  const s2 = await snapshotTarget(ws, "loose");
  assert.ok(!("error" in s2));
  if ("error" in s2) return;
  assert.equal(s2.source.kind, "folder");
  const names = execFileSync("tar", ["-tf", s2.file]).toString().trim().split("\n").sort();
  assert.deepEqual(names, [".env.example", "main.py", "sub/", "sub/deep.txt"]);
  const out = path.join(root, "x");
  mkdirSync(out);
  execFileSync("tar", ["-xf", s2.file, "-C", out]);
  assert.equal(readFileSync(path.join(out, "sub", "deep.txt"), "utf8"), "deep\n");
  s2.cleanup();
  assert.ok(!existsSync(s2.file));
});

test("the reviewers' room: closed network, the snapshot unpacked at /work/src, deleted on close", async () => {
  const f = fake();
  const room = await openReviewRoom({ runId: RUN, projectId: "p1", sessionId: "s1", ws, target: "app", size: "sealed-1x2", maxMinutes: 45 }, f.deps);
  assert.equal(room.error, undefined);
  assert.equal(room.sandboxId, SID);
  assert.equal(room.imageDigest, DIGEST);
  assert.equal(f.creates[0].internet, false);
  assert.equal(f.creates[0].allowHosts, undefined);
  assert.equal(f.creates[0].purpose, "qa-hound");
  assert.equal(f.creates[0].lifetimeSeconds, 55 * 60);
  assert.deepEqual(f.calls.map((a) => a[0]), ["put", "exec"]);
  assert.equal(f.calls[0][f.calls[0].indexOf("--path") + 1], "/work/src.tar");
  assert.match(f.calls[1][f.calls[1].indexOf("--cmd") + 1], /mkdir -p \/work\/src && tar -xf \/work\/src.tar -C \/work\/src/);
  await closeReviewRoom(room, f.deps);
  assert.ok(room.deleted);
  assert.deepEqual(room.receiptHead, { n: 7, sha256: "2".repeat(64) });
  const d = fake({ deny: true });
  const no = await openReviewRoom({ runId: RUN, projectId: "p1", sessionId: "s1", ws, target: "app", size: "sealed-1x2", maxMinutes: 45 }, d.deps);
  assert.match(no.error!, /owner said no/);
  assert.equal(d.calls.length, 0);
  const p = fake({ putFails: true });
  const bad = await openReviewRoom({ runId: RUN, projectId: "p1", sessionId: "s1", ws, target: "app", size: "sealed-1x2", maxMinutes: 45 }, p.deps);
  assert.match(bad.error!, /upload failed/);
  assert.deepEqual(p.deletes, [SID], "a room that could not be filled is deleted");
});

test("a repo whose own config would run a command is refused", async () => {
  const evil = path.join(ws, "evil");
  mkdirSync(evil);
  g(evil, "init", "-q");
  writeFileSync(path.join(evil, "a.txt"), "a\n");
  g(evil, "add", ".");
  g(evil, "commit", "-qm", "a");
  g(evil, "config", "core.fsmonitor", "touch /tmp/pwned");
  const f = fake();
  const r = await runCleanMachine(input(opts(), "evil"), f.deps);
  assert.equal(r.ok, false);
  assert.match(r.error!, /core\.fsmonitor/);
  const s = await snapshotTarget(ws, "evil");
  assert.ok("error" in s);
});

test("OpenCode tools: plan mode turns MCP off; review_exec only for a sandboxed reviewer in a Cathedral project", async () => {
  const { promptTools } = await import("./engines/opencode.js");
  const base = { enabledMcp: ["cathedral"], integrationIds: ["atlas", "cathedral"], routerMcp: [] as string[] };
  const plain = promptTools({ ...base, plan: true });
  assert.equal(plain["cathedral_*"], false);
  assert.equal(plain["bitbull_*"], false);
  assert.equal(plain.cathedral_review_exec, false, "off outside a sandboxed review, ordinary chats included");
  const sandboxed = promptTools({ ...base, plan: true, reviewSandbox: true });
  assert.equal(sandboxed["cathedral_*"], false, "the rest of Cathedral stays off");
  assert.equal(sandboxed.cathedral_review_exec, true);
  // never outside plan mode (the chat tools already have it), never without Cathedral on for the project
  assert.equal(promptTools({ ...base, plan: false, reviewSandbox: true }).cathedral_review_exec, false, "off outside a sandboxed review, ordinary chats included");
  assert.equal(promptTools({ ...base, enabledMcp: [], plan: true, reviewSandbox: true }).cathedral_review_exec, false, "off outside a sandboxed review, ordinary chats included");
});
