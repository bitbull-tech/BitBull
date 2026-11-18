/**
 * The secret-name list BitBull uses before anything leaves the machine for a Cathedral sandbox:
 * the same names the linked-folder copy leaves out, applied to named uploads, folder snapshots and
 * clean-machine archives. Also QA Hound's clean-machine check: verify has to pass, not be missing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "bitbull-secret-names-"));
process.env.DATA_DIR = path.join(dir, "data");
after(() => rmSync(dir, { recursive: true, force: true }));

const { isSecretName, secretPart } = await import("./secretNames.js");
const { namedFile } = await import("./cathedral.js");
const { skipped, snapshotTarget } = await import("./cleanMachine.js");
const { cleanMachineCheck } = await import("./swarm.js");
type Certificate = import("./cleanMachine.js").Certificate;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("every secret exclude in the linked-folder copy (bitbull-links.sh) is covered", () => {
  const sh = readFileSync(path.join(REPO_ROOT, "scripts/bitbull-wsl/bitbull-links.sh"), "utf8");
  // the excludes before the dependency/cache folders are the secret ones
  const block = sh.slice(sh.indexOf("--exclude=.env "), sh.indexOf("--exclude=node_modules"));
  const patterns = [...block.matchAll(/--exclude=(?:'([^']+)'|(\S+))/g)].map((m) => m[1] ?? m[2]);
  assert.ok(patterns.length > 30, `found ${patterns.length} patterns`);
  for (const p of patterns) {
    // a concrete name each pattern matches: '*.pem' -> 'x.pem', 'coldkey*' -> 'coldkeyx'
    const example = p.replace(/^\*/, "x").replace(/\*$/, "x").replace(/\*/g, "x");
    assert.ok(isSecretName(example), `${p} (as ${example})`);
  }
});

test("keys, wallets and .env files are secret; templates and ordinary code are not", () => {
  for (const n of [".env", ".env.local", "server.pem", "TLS.KEY", "coldkey", "coldkeypub.txt", "hotkeys", "hotkey_backup", "id_ed25519", "id_rsa.pub", "wallet.dat", "wallet-main.json", "my-mnemonic.txt", "seed_phrase.txt", ".ssh", ".bittensor", "credentials.json", "settings.local.json"])
    assert.equal(isSecretName(n), true, n);
  for (const n of [".env.example", ".env.template", "index.ts", "id_generator.py", "keys.ts", "README.md", "notes.txt", "hotkey.py", "hotkeys.ts", "coldkey_utils.py"])
    assert.equal(isSecretName(n), false, n);
  assert.equal(secretPart("a/.ssh/config"), ".ssh");
  assert.equal(secretPart("src/app.py"), null);
});

test("upload refuses keys and wallets by name and inside secret folders", () => {
  const ws = path.join(dir, "ws");
  mkdirSync(path.join(ws, "wallets"), { recursive: true });
  mkdirSync(path.join(ws, ".bittensor", "wallets"), { recursive: true });
  for (const f of ["server.pem", "coldkey", "wallets/hotkey", ".bittensor/wallets/x.json", "app.py"]) writeFileSync(path.join(ws, f), "x");
  for (const f of ["server.pem", "coldkey", "wallets/hotkey", ".bittensor/wallets/x.json"]) {
    const r = namedFile(ws, f, true);
    assert.equal(typeof r, "object", f);
    assert.match((r as { error: string }).error, /keys or secrets/, f);
  }
  assert.equal(typeof namedFile(ws, "app.py", true), "string");
  // and as a download target
  assert.equal(typeof namedFile(ws, "out.pem", false), "object");
});

test("folder snapshot leaves out keys and wallets; a commit holding one is refused, not copied from disk", async () => {
  for (const n of [".git", ".env", "a.pem", "coldkey", ".ssh"]) assert.equal(skipped(n), true, n);
  assert.equal(skipped("src"), false);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, "app.py"), "print(1)\n");
  writeFileSync(path.join(repo, "deploy.pem"), "-----BEGIN PRIVATE KEY-----\n");
  git("add", ".");
  git("commit", "-qm", "init");
  // no fallback to the folder on disk, which would carry gitignored files too
  writeFileSync(path.join(repo, ".gitignore"), ".dev.vars\n");
  writeFileSync(path.join(repo, ".dev.vars"), "TOKEN=x\n");
  const snap = await snapshotTarget(dir, "repo");
  assert.ok("error" in snap, JSON.stringify(snap));
  assert.match((snap as { error: string }).error, /deploy\.pem.*looks like a key/);
});

test("a folder copy inside a repo (not committed yet) leaves out what git ignores", async () => {
  const repo = path.join(dir, "repo2");
  mkdirSync(path.join(repo, "newpkg", "build"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(path.join(repo, ".gitignore"), "secrets.toml\nbuild/\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(path.join(repo, "newpkg", "main.py"), "print(1)\n");
  writeFileSync(path.join(repo, "newpkg", "secrets.toml"), "token = 'x'\n");
  writeFileSync(path.join(repo, "newpkg", "build", "out.bin"), "x");
  const snap = await snapshotTarget(dir, "repo2/newpkg");
  assert.ok(!("error" in snap), JSON.stringify(snap));
  if ("error" in snap) return;
  try {
    assert.equal(snap.source.kind, "folder");
    const names = execFileSync("tar", ["-tf", snap.file], { encoding: "utf8" });
    assert.match(names, /main\.py/);
    assert.doesNotMatch(names, /secrets\.toml/);
    assert.doesNotMatch(names, /out\.bin/);
  } finally {
    snap.cleanup();
  }
  // one ignored file named as the target is refused
  const one = await snapshotTarget(dir, "repo2/newpkg/secrets.toml");
  assert.ok("error" in one);
});

test("clean-machine check: verify not available does not pass; verify passed does", () => {
  const head = "a".repeat(40);
  const cert = (ok: boolean | undefined) => ({ result: "pass", repo: { commit: head }, verify: { ok }, commands: [] }) as unknown as Certificate;
  const missing = cleanMachineCheck(cert(undefined), head);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /was not available/);
  const failed = cleanMachineCheck(cert(false), head);
  assert.equal(failed.ok, false);
  assert.match(failed.text, /failed/);
  assert.equal(cleanMachineCheck(cert(true), head).ok, true);
  assert.equal(cleanMachineCheck(undefined, head, "no key").ok, false);
});
