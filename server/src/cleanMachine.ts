/**
 * QA Hound on Cathedral confidential sandboxes, run by BitBull itself (no model in the loop):
 *
 *  - "Run it in a confidential sandbox": a snapshot of the target (its exact commit when it is in a git
 *    repo, else a filtered copy of the folder) goes into a fresh room with the network closed, and
 *    the run's reviewers may run commands there (cathedral.ts review_exec).
 *  - The clean-machine test: the repo at its exact commit, the project's install, build and test
 *    commands, network closed apart from the hosts install needs. The result is a certificate
 *    saved with the verdict: what ran, how it ended, the room, the receipt chain head, what
 *    Cathedral's verify said, and how anyone can check it offline.
 *
 * Every Cathedral call goes through injected functions (CathedralDeps), so the tests drive this
 * module with a fake helper and never reach the network.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execCapableConfig } from "./repos.js";
import { isSecretName, secretPart } from "./secretNames.js";

const run = promisify(execFile);

// ---------- options ----------

export interface CleanMachineOptions {
  enabled: boolean;
  install: string;
  build: string;
  test: string;
  /** hosts install may reach (package registries); empty = network closed */
  allowHosts: string[];
  size: string;
}

export const DEFAULT_SANDBOX_SIZE = "sealed-1x2";
export const DEFAULT_CLEAN_SIZE = "sealed-2x4";

// ---------- what this module needs from cathedral.ts ----------

export interface CreateArgs {
  purpose: "qa-hound" | "clean-machine";
  projectId: string;
  sessionId?: string;
  size: string;
  lifetimeSeconds: number;
  internet: boolean;
  allowHosts?: string[];
  reason: string;
  op: string;
  task?: string;
}

export interface CathedralDeps {
  helper(argv: string[]): Promise<{ code: number; out: Record<string, any> }>;
  /** raises the owner's approval card, waits, creates (cathedral.ts createRoom) */
  createRoom(input: CreateArgs): Promise<Record<string, any>>;
  /** deletes a room this run created (cathedral.ts deleteRoom) */
  deleteRoom(sandboxId: string, task: string): Promise<Record<string, any>>;
  /** Cathedral's API origin, for the public receipt links */
  apiUrl(): string;
  log(level: "info" | "warn" | "error", message: string, detail?: string): void;
  now?(): number;
}

/** A task tag of its own per run and purpose (a-z0-9, at most 24): every op name is keyed by it. */
export const taskTag = (prefix: "h" | "c", runId: string) => (prefix + runId.toLowerCase().replace(/[^a-z0-9]/g, "")).slice(0, 24);

// ---------- git, hardened ----------

/**
 * git as in mcp.ts ditto_review: no user or system config, and the repo's own exec knobs
 * neutralised by env-level config (it outranks repo config). Callers also refuse a repo whose own
 * config names anything git would execute (execCapableConfig) before running git in it.
 */
function gitEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LC_ALL: "C",
    HOME: "/nonexistent",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS: "'core.fsmonitor=' 'diff.external=' 'core.pager=cat' 'core.hooksPath=/dev/null'",
  };
}

async function git(dir: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir, timeout, maxBuffer: 16 * 1024 * 1024, env: gitEnv() });
  return String(stdout);
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

/** The git clone holding a workspace path: the nearest folder at or above it, inside the workspace, with a .git. */
export function repoRootOf(ws: string, target: string): string | undefined {
  let wsReal: string;
  let dir: string;
  try {
    wsReal = realpathSync(ws);
    dir = realpathSync(path.resolve(ws, target));
  } catch {
    return undefined;
  }
  if (!inside(wsReal, dir)) return undefined;
  try {
    if (!statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    return undefined;
  }
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (dir === wsReal) return undefined;
    dir = path.dirname(dir);
    if (!inside(wsReal, dir)) return undefined;
  }
}

/** A remote URL with any user name, password or token taken out. */
export function stripCredentials(url: string): string {
  const u = url.trim();
  try {
    const parsed = new URL(u);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // scp-like git@host:owner/repo keeps its user (it is not a secret); anything else with an @ before the host loses it
    return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(u) ? u : u.replace(/^[^@/]*@/, "");
  }
}

export interface RepoState {
  dir: string;
  /** workspace-relative */
  rel: string;
  commit: string;
  remote?: string;
  /** uncommitted changes in the working copy (not part of the snapshot) */
  dirty: number;
}

export async function repoState(ws: string, repoDir: string): Promise<RepoState | { error: string }> {
  const unsafe = await execCapableConfig(repoDir);
  if (unsafe.length) return { error: `Refused: the repo's own git config sets ${unsafe.slice(0, 4).join(", ")}, which git would run as a command. Remove it, or review without the confidential sandbox.` };
  let commit: string;
  try {
    commit = (await git(repoDir, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  } catch {
    return { error: "The repo has no commit yet, so there is no exact commit to snapshot." };
  }
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) return { error: "git did not give a commit id." };
  let remote: string | undefined;
  try {
    remote = stripCredentials((await git(repoDir, ["config", "--get", "remote.origin.url"])).trim()) || undefined;
  } catch {
    /* no origin */
  }
  let dirty = 0;
  try {
    dirty = (await git(repoDir, ["--no-optional-locks", "status", "--porcelain"])).split("\n").filter(Boolean).length;
  } catch {
    /* unknown; the snapshot is HEAD either way */
  }
  const wsReal = realpathSync(ws);
  return { dir: repoDir, rel: path.relative(wsReal, repoDir).split(path.sep).join("/") || ".", commit, remote, dirty };
}

// ---------- a folder as a tar, without secrets ----------

export const MAX_SNAPSHOT_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 50_000;

/** Left out of a folder snapshot: .git, anything that looks like a key or wallet (secretNames.ts; .env templates stay), symlinks and anything that isn't a file or folder. */
export function skipped(name: string): boolean {
  if (name === ".git") return true;
  return isSecretName(name);
}

function tarHeader(name: string, size: number, type: "0" | "5" | "x", mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s, off, Math.min(len, Buffer.byteLength(s)), "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  h.fill(" ", 148, 156);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

/** A pax record "<len> path=<name>\n", where len counts itself. */
function paxPath(name: string): Buffer {
  const body = ` path=${name}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, "utf8");
}

/**
 * Write a tar of a folder (or one file) to `out`: regular files and folders only, never through a
 * link, skipping .git and .env files. Throws when it would be over the upload limit.
 */
export function tarFolder(src: string, out: string, keep?: { files: Set<string>; dirs: Set<string> }): { files: number; bytes: number; skipped: number } {
  const fd = openSync(out, "wx", 0o600);
  let total = 0;
  let files = 0;
  let skips = 0;
  const write = (b: Buffer) => {
    total += b.length;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error("The target is over 200 MiB, the limit for one upload.");
    writeSync(fd, b);
  };
  const pad = (n: number) => (n % 512 ? Buffer.alloc(512 - (n % 512)) : Buffer.alloc(0));
  const entry = (name: string, type: "0" | "5", mode: number, mtime: number, data?: Buffer) => {
    const size = data?.length ?? 0;
    if (Buffer.byteLength(name) > 100) {
      const pax = paxPath(name);
      write(tarHeader("PaxHeader", pax.length, "x", 0o644, mtime));
      write(pax);
      write(pad(pax.length));
    }
    write(tarHeader(name, size, type, mode, mtime));
    if (data) {
      write(data);
      write(pad(size));
    }
  };
  const walk = (abs: string, rel: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(abs, d.name);
      const r = rel ? `${rel}/${d.name}` : d.name;
      const st = lstatSync(p);
      const unlisted = keep && !(st.isDirectory() ? keep.dirs.has(r) : keep.files.has(r));
      if (unlisted || skipped(d.name) || st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) {
        skips++;
        continue;
      }
      if (++files > MAX_FILES) throw new Error(`The target has more than ${MAX_FILES} files.`);
      const mtime = Math.floor(st.mtimeMs / 1000);
      if (st.isDirectory()) {
        entry(`${r}/`, "5", 0o755, mtime);
        walk(p, r);
      } else entry(r, "0", st.mode & 0o111 ? 0o755 : 0o644, mtime, readFileSync(p));
    }
  };
  try {
    const st = lstatSync(src);
    if (st.isSymbolicLink()) throw new Error("The target is a link; it is not followed.");
    if (st.isDirectory()) walk(src, "");
    else if (skipped(path.basename(src))) throw new Error(`${path.basename(src)} holds secrets and is never sent.`);
    else {
      files = 1;
      entry(path.basename(src), "0", st.mode & 0o111 ? 0o755 : 0o644, Math.floor(st.mtimeMs / 1000), readFileSync(src));
    }
    write(Buffer.alloc(1024));
  } finally {
    closeSync(fd);
  }
  return { files, bytes: total, skipped: skips };
}

// ---------- snapshots ----------

export interface Snapshot {
  file: string;
  bytes: number;
  sha256: string;
  /** what it holds: a commit of a repo (and the target path inside it), or a folder copy */
  source: { kind: "git"; repo: string; commit: string; path: string; dirty: number } | { kind: "folder"; skipped: number };
  cleanup(): void;
}

const tempDir = () => mkdtempSync(path.join(tmpdir(), "bitbull-hound-"));
const fileSha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** The commit holds a file that looks like a key or wallet: refused, never replaced by a folder copy. */
class SecretInCommit extends Error {}

/**
 * Inside a repo, the files git would track (committed or new, not ignored) under `sub`, relative
 * to `sub`, with the folders that hold them: so a folder copy never picks up gitignored secrets
 * such as .dev.vars or secrets.toml.
 */
async function gitListed(repoDir: string, sub: string): Promise<{ files: Set<string>; dirs: Set<string> }> {
  const out = await git(repoDir, ["ls-files", "-co", "--exclude-standard", "-z", "--", sub || "."], 60_000);
  const files = new Set<string>();
  const dirs = new Set<string>();
  const prefix = sub ? `${sub}/` : "";
  for (const f of out.split("\0").filter(Boolean)) {
    if (prefix && !f.startsWith(prefix)) continue;
    const rel = f.slice(prefix.length);
    files.add(rel);
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return { files, dirs };
}

/** `git archive` of HEAD (or of one path at HEAD), written outside the workspace. */
async function archive(repoDir: string, out: string, sub: string, rev = "HEAD"): Promise<void> {
  // <rev>:<dir> roots the tar at that folder; a file keeps its path (a blob can't be archived alone)
  let args = ["archive", "--format=tar", "-o", out, rev];
  if (sub) {
    const type = (await git(repoDir, ["cat-file", "-t", `${rev}:${sub}`])).trim();
    args = type === "tree" ? ["archive", "--format=tar", "-o", out, `${rev}:${sub}`] : ["archive", "--format=tar", "-o", out, rev, "--", sub];
  }
  // a committed key, wallet or .env file would go to the room through Cathedral's API in plaintext: refuse
  const listed = (await git(repoDir, ["ls-tree", "-r", "--name-only", "-z", rev, ...(sub ? ["--", sub] : [])], 60_000)).split("\0").filter(Boolean);
  const secret = listed.find((f) => secretPart(f) !== null);
  if (secret) throw new SecretInCommit(`The commit holds ${secret}, which looks like a key, wallet or .env file; it is not sent to a sandbox. Remove it from the repo first.`);
  await git(repoDir, args, 300_000);
  if (statSync(out).size > MAX_SNAPSHOT_BYTES) throw new Error("The snapshot is over 200 MiB, the limit for one upload.");
}

/**
 * The target as a tar: its exact commit when it is in a git repo (and committed there), else a
 * filtered copy of the folder or file. Returns why not when it can't be taken safely.
 */
export async function snapshotTarget(ws: string, target: string): Promise<Snapshot | { error: string }> {
  const abs = path.resolve(ws, target);
  const repoDir = repoRootOf(ws, target);
  const dir = tempDir();
  const file = path.join(dir, "src.tar");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    if (repoDir) {
      const st = await repoState(ws, repoDir);
      if ("error" in st) {
        cleanup();
        return st;
      }
      const sub = path.relative(repoDir, realpathSync(abs)).split(path.sep).join("/");
      try {
        await archive(repoDir, file, sub, st.commit);
        return { file, bytes: statSync(file).size, sha256: fileSha(file), source: { kind: "git", repo: st.rel, commit: st.commit, path: sub || ".", dirty: st.dirty }, cleanup };
      } catch (e) {
        if (e instanceof SecretInCommit) {
          cleanup();
          return { error: e.message };
        }
        // not committed at HEAD (a new folder, say): fall back to the folder as it is
        rmSync(file, { force: true });
      }
    }
    let realAbs = "";
    try {
      realAbs = realpathSync(abs);
    } catch {
      /* missing: tarFolder says so */
    }
    const realWs = realpathSync(ws);
    if (realAbs && !(realAbs === realWs || realAbs.startsWith(realWs + path.sep))) throw new Error("The target leads outside this workspace through a link; it is not copied.");
    // inside a repo, only what git would track by the repo's own .gitignore (BitBull's git reads no
    // global config, so a global excludes file is not applied): ignored local secrets stay out
    let keep: { files: Set<string>; dirs: Set<string> } | undefined;
    if (repoDir && realAbs) {
      const rel = path.relative(realpathSync(repoDir), realAbs).split(path.sep).join("/");
      if (lstatSync(realAbs).isDirectory()) {
        keep = await gitListed(repoDir, rel);
        if (!keep.files.size) throw new Error(`${target} holds nothing git would track (it is ignored or empty); nothing is copied.`);
      }
      else {
        const dirRel = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
        if (!(await gitListed(repoDir, dirRel)).files.has(path.posix.basename(rel))) throw new Error(`${target} is ignored by git; it is not copied.`);
      }
    }
    const t = tarFolder(abs, file, keep);
    return { file, bytes: t.bytes, sha256: fileSha(file), source: { kind: "folder", skipped: t.skipped }, cleanup };
  } catch (e) {
    cleanup();
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- the reviewers' room ----------

export interface ReviewRoom {
  sandboxId?: string;
  task: string;
  image?: string;
  imageDigest?: string;
  receiptId?: string;
  snapshot?: Snapshot["source"] & { sha256: string; bytes: number };
  receiptHead?: { n: number | null; sha256: string | null };
  deleted?: boolean;
  error?: string;
}

const errText = (o: Record<string, any>) => String(o?.message ?? o?.error ?? "unknown error").slice(0, 300);

/**
 * Snapshot, create (the owner approves), upload, extract. On any failure after the room exists,
 * the room is deleted before returning. The caller grants the room to the reviewers and calls
 * closeReviewRoom at the end of the run.
 */
export async function openReviewRoom(
  input: { runId: string; projectId: string; sessionId: string; ws: string; target: string; size: string; maxMinutes: number },
  deps: CathedralDeps,
): Promise<ReviewRoom> {
  const task = taskTag("h", input.runId);
  const room: ReviewRoom = { task };
  const snap = await snapshotTarget(input.ws, input.target);
  if ("error" in snap) return { ...room, error: snap.error };
  try {
    room.snapshot = { ...snap.source, sha256: snap.sha256, bytes: snap.bytes };
    const what = snap.source.kind === "git" ? `${snap.source.repo} at ${snap.source.commit.slice(0, 12)}` : `a copy of ${input.target}`;
    const made = await deps.createRoom({
      purpose: "qa-hound",
      projectId: input.projectId,
      sessionId: input.sessionId,
      size: input.size,
      lifetimeSeconds: (input.maxMinutes + 10) * 60,
      internet: false,
      reason: `QA Hound on ${input.target}: the reviewers may run its code and tests in a confidential sandbox holding ${what}, network closed.`,
      op: "create",
      task,
    });
    if (!made.ok || typeof made.sandbox_id !== "string") return { ...room, error: errText(made) };
    room.sandboxId = made.sandbox_id;
    room.image = made.image ?? undefined;
    room.imageDigest = made.image_digest ?? undefined;
    room.receiptId = made.receipt_id ?? undefined;
    const put = (await deps.helper(["put", made.sandbox_id, "--task", task, "--op", "putsrc", "--src", snap.file, "--path", "/work/src.tar"])).out;
    if (!put.ok) throw new Error(`upload failed: ${errText(put)}`);
    deps.log("info", `QA Hound sent ${what} to confidential sandbox ${made.sandbox_id}: ${input.target} → /work/src.tar (${snap.bytes} bytes, sha256 ${snap.sha256})`);
    const x = (await deps.helper(["exec", made.sandbox_id, "--task", task, "--op", "extract", "--cmd", "mkdir -p /work/src && tar -xf /work/src.tar -C /work/src", "--cwd", "/work", "--timeout", "45"])).out;
    if (!x.ok) throw new Error(`unpacking failed: ${errText(x)}`);
    return room;
  } catch (e) {
    room.error = e instanceof Error ? e.message : String(e);
    await closeReviewRoom(room, deps);
    return room;
  } finally {
    snap.cleanup();
  }
}

/** Delete the room (if there is one) and record the final receipt head. Never throws. */
export async function closeReviewRoom(room: ReviewRoom, deps: CathedralDeps): Promise<void> {
  if (!room.sandboxId || room.deleted) return;
  try {
    const d = await deps.deleteRoom(room.sandboxId, room.task);
    room.deleted = !!d.ok;
    if (d.receipts) room.receiptHead = { n: d.receipts.head_n ?? null, sha256: d.receipts.head_sha256 ?? null };
    if (!d.ok) room.error ??= `the room could not be deleted: ${errText(d)}`;
  } catch (e) {
    room.error ??= `the room could not be deleted: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- the clean-machine certificate ----------

export type Step = "install" | "build" | "test";

export interface CertCommand {
  step: Step;
  command: string;
  /** sha256 of the shell string as UTF-8: what Cathedral's exec receipt binds as command_sha256 */
  commandSha256?: string;
  /** exited / failed / timed_out / killed / lost / error / not_run */
  state: string;
  exitCode: number | null;
  ok: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number | null;
  /** sha256 of the returned text as UTF-8, the scope Cathedral's exec receipt binds */
  stdoutSha256?: string;
  stderrSha256?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  roomReceiptId?: string | null;
  note?: string;
}

export interface Certificate {
  schema: "bitbull_clean_machine_certificate_v1";
  id: string;
  result: "pass" | "fail" | "incomplete";
  repo: { path: string; remote?: string; commit: string; uncommittedChanges: number; archiveSha256: string; archiveBytes: number };
  commands: CertCommand[];
  room: {
    sandboxId: string;
    size: string;
    image: string | null;
    imageDigest: string | null;
    network: "closed" | "allowlist";
    allowHosts: string[];
    hotel: string | null;
    createdAt: string | null;
    maxSpendUsd: string | null;
    createReceiptId: string | null;
    createReceiptUrl: string | null;
    attestationUrl: string | null;
  };
  startedAt: string;
  finishedAt: string;
  receiptHead: { count: number | null; n: number | null; sha256: string | null; from: "delete" | "status" | "none" };
  verify: { ok: boolean | null; checked: string[]; notChecked: string[]; error?: string };
  evidence: { path?: string; sha256?: string; bytes?: number; schema?: string | null; error?: string };
  deleted: boolean;
  deleteError?: string;
  /** why the run stopped early, when it did */
  failure?: string;
  files?: { json: string; md: string };
}

export interface CleanResult {
  ok: boolean;
  certificate?: Certificate;
  markdown?: string;
  error?: string;
}

const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A public link on the API origin: Cathedral returns receipt URLs as paths. */
export function publicUrl(apiUrl: string, p: string | null | undefined): string | null {
  if (!p || typeof p !== "string") return null;
  try {
    const u = new URL(p, apiUrl);
    return u.protocol === "https:" || u.hostname === "127.0.0.1" || u.hostname === "localhost" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * <workspace>/.bitbull/certificates, made if needed, and only if no part of it is a link: the
 * workspace is the agent's to write, so a planted link must not steer BitBull's writes elsewhere.
 */
export function certificatesDir(ws: string): string {
  const wsReal = realpathSync(ws);
  let dir = wsReal;
  for (const part of [".bitbull", "certificates"]) {
    dir = path.join(dir, part);
    if (existsSync(dir) || lstatExists(dir)) {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${path.relative(wsReal, dir)} is not a plain folder; certificates are not written through it.`);
    } else mkdirSync(dir, { mode: 0o755 });
  }
  return dir;
}
function lstatExists(p: string) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Write a file afresh: an existing entry (a link included) is removed first, and the write refuses to follow one. */
function writeFresh(file: string, data: string | Buffer) {
  if (lstatExists(file)) unlinkSync(file);
  writeFileSync(file, data, { flag: "wx", mode: 0o644 });
}

/**
 * The clean-machine test. Deterministic: BitBull runs the commands, no model. `deadline` is the
 * moment the run's time limit (its reviewer share) ends; commands get no more than what is left.
 */
export async function runCleanMachine(
  input: { runId: string; projectId: string; sessionId: string; ws: string; target: string; options: CleanMachineOptions; deadline: number },
  deps: CathedralDeps,
): Promise<CleanResult> {
  const now = () => deps.now?.() ?? Date.now();
  const startedAt = now();
  const o = input.options;
  const steps = (["install", "build", "test"] as const).filter((s) => o[s].trim()).map((s) => ({ step: s, command: o[s].trim() }));
  if (!steps.length) return { ok: false, error: "No install, build or test command was given." };
  if (!SAFE_ID.test(input.runId)) return { ok: false, error: "bad run id" };
  const repoDir = repoRootOf(input.ws, input.target);
  if (!repoDir) return { ok: false, error: `${input.target} is not in a git repo. The certificate is about a commit, so the clean-machine test needs one.` };
  const st = await repoState(input.ws, repoDir);
  if ("error" in st) return { ok: false, error: st.error };
  const repo: RepoState = st;

  const task = taskTag("c", input.runId);
  const tmp = tempDir();
  const tar = path.join(tmp, "src.tar");
  let sandboxId: string | undefined;
  const room: Partial<Certificate["room"]> = {};
  const commands: CertCommand[] = steps.map((s) => ({ ...s, state: "not_run", exitCode: null, ok: false }));
  let failure: string | undefined;
  let verify: Certificate["verify"] = { ok: null, checked: [], notChecked: [] };
  const evidence: Certificate["evidence"] = {};
  let deleted = false;
  let deleteError: string | undefined;
  let head: Certificate["receiptHead"] = { count: null, n: null, sha256: null, from: "none" };
  let certDir: string;
  try {
    certDir = certificatesDir(input.ws);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  let tarSha = "";
  let tarBytes = 0;
  let early: string | undefined;
  try {
    try {
      // the commit the certificate names, not whatever HEAD is by now
      await archive(repoDir, tar, "", st.commit);
      tarSha = fileSha(tar);
      tarBytes = statSync(tar).size;
    } catch (e) {
      early = `git archive failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!early) {
      const remainingMin = Math.max(1, Math.ceil((input.deadline - now()) / 60_000));
      const made = await deps.createRoom({
        purpose: "clean-machine",
        projectId: input.projectId,
        sessionId: input.sessionId,
        size: o.size,
        lifetimeSeconds: Math.min(86_400, Math.max(600, (remainingMin + 10) * 60)),
        // never the open internet: closed, or closed apart from the hosts install needs
        internet: false,
        allowHosts: o.allowHosts.length ? o.allowHosts : undefined,
        reason: `Clean-machine test of ${st.rel} at ${st.commit.slice(0, 12)}: run ${steps.map((s) => s.step).join(", ")} in a fresh confidential sandbox, network ${o.allowHosts.length ? `closed apart from ${o.allowHosts.join(", ")}` : "closed"}.`,
        op: "create",
        task,
      });
      if (!made.ok || typeof made.sandbox_id !== "string") early = `No room: ${errText(made)}`;
      else {
        sandboxId = made.sandbox_id;
        await inRoom(made.sandbox_id, made);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (sandboxId) failure ??= msg;
    else early ??= msg;
  } finally {
    if (sandboxId) {
      try {
        const d = await deps.deleteRoom(sandboxId, task);
        deleted = !!d.ok;
        if (!d.ok) deleteError = errText(d);
        // the chain head after the delete includes the delete receipt
        if (d.receipts && typeof d.receipts === "object") head = { count: d.receipts.count ?? null, n: d.receipts.head_n ?? null, sha256: d.receipts.head_sha256 ?? null, from: "delete" };
        if (d.ok) {
          const after = (await deps.helper(["status", sandboxId])).out;
          const r = after.ok && after.receipts && typeof after.receipts === "object" ? after.receipts : null;
          if (r && typeof r.head_sha256 === "string" && /^[0-9a-f]{64}$/.test(r.head_sha256)) head = { count: r.count ?? head.count, n: r.head_n ?? head.n, sha256: r.head_sha256, from: "delete" };
        }
      } catch (e) {
        deleteError = e instanceof Error ? e.message : String(e);
      }
      if (!deleted) deps.log("warn", `Clean-machine room ${sandboxId} was not deleted: ${deleteError}. It ends at its lifetime.`);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!sandboxId) return { ok: false, error: early ?? "no room" };

  for (const c of commands) if (c.state === "not_run") c.note ??= failure ? "not run: an earlier step did not succeed" : "not run";
  const ran = commands.filter((c) => c.state !== "not_run");
  const certificate: Certificate = {
    schema: "bitbull_clean_machine_certificate_v1",
    id: input.runId,
    result: commands.every((c) => c.ok) ? "pass" : ran.some((c) => !c.ok) ? "fail" : "incomplete",
    repo: { path: st.rel, remote: st.remote, commit: st.commit, uncommittedChanges: st.dirty, archiveSha256: tarSha, archiveBytes: tarBytes },
    commands,
    room: {
      sandboxId,
      size: o.size,
      image: room.image ?? null,
      imageDigest: room.imageDigest ?? null,
      network: o.allowHosts.length ? "allowlist" : "closed",
      allowHosts: [...o.allowHosts],
      hotel: room.hotel ?? null,
      createdAt: room.createdAt ?? null,
      maxSpendUsd: room.maxSpendUsd ?? null,
      createReceiptId: room.createReceiptId ?? null,
      createReceiptUrl: room.createReceiptUrl ?? null,
      attestationUrl: room.attestationUrl ?? null,
    },
    startedAt: iso(startedAt),
    finishedAt: iso(now()),
    receiptHead: head,
    verify,
    evidence,
    deleted,
    ...(deleteError ? { deleteError } : {}),
    ...(failure ? { failure } : {}),
  };
  const markdown = renderCertificate(certificate);
  try {
    const json = path.join(certDir, `${input.runId}.json`);
    const md = path.join(certDir, `${input.runId}.md`);
    certificate.files = { json: rel(input.ws, json), md: rel(input.ws, md) };
    writeFresh(json, JSON.stringify(certificate, null, 2) + "\n");
    writeFresh(md, markdown);
  } catch (e) {
    certificate.files = undefined;
    return { ok: true, certificate, markdown, error: `the certificate could not be saved: ${e instanceof Error ? e.message : String(e)}` };
  }
  deps.log(certificate.result === "pass" ? "info" : "warn", `Clean-machine certificate for ${st.rel} at ${st.commit.slice(0, 12)}: ${certificate.result.toUpperCase()} (${certificate.files.md})`);
  return { ok: true, certificate, markdown };

  async function inRoom(id: string, made: Record<string, any>) {
    Object.assign(room, {
      sandboxId: id,
      image: made.image ?? null,
      imageDigest: made.image_digest ?? null,
      hotel: typeof made.hotel === "string" && SAFE_ID.test(made.hotel) ? made.hotel : null,
      createdAt: made.created_at ?? null,
      maxSpendUsd: made.max_spend_usd ?? null,
      createReceiptId: made.receipt_id ?? null,
    });
    deps.log("info", `Clean-machine test: room ${id} for ${repo.rel} at ${repo.commit.slice(0, 12)}`);
    const put = (await deps.helper(["put", id, "--task", task, "--op", "putsrc", "--src", tar, "--path", "/work/src.tar"])).out;
    if (!put.ok) failure = `upload failed: ${errText(put)}`;
    else deps.log("info", `Clean-machine test sent git archive of ${repo.rel} at ${repo.commit.slice(0, 12)} to confidential sandbox ${id}: /work/src.tar (${tarBytes} bytes, sha256 ${tarSha})`);
    if (!failure) {
      const x = (await deps.helper(["exec", id, "--task", task, "--op", "extract", "--cmd", "mkdir -p /work/src && tar -xf /work/src.tar -C /work/src && rm /work/src.tar", "--cwd", "/work", "--timeout", "45"])).out;
      if (!x.ok) failure = `unpacking failed: ${errText(x)}`;
    }
    // each command in order; the first that doesn't exit 0 stops the rest
    for (let i = 0; i < commands.length && !failure; i++) {
      const c = commands[i];
      const left = Math.floor((input.deadline - now()) / 1000);
      if (left < 5) {
        failure = "the run's time limit was reached";
        c.note = "not run: the run's time limit was reached";
        break;
      }
      const timeout = Math.min(1800, left);
      const t0 = now();
      const bg = (await deps.helper(["exec-bg", id, "--task", task, "--op", `step${i + 1}${c.step}`, "--cmd", c.command, "--cwd", "/work/src", "--timeout", String(timeout)])).out;
      if (!bg.ok || typeof bg.exec_id !== "string") {
        c.state = "error";
        c.note = `could not start: ${errText(bg)}`;
        failure = `${c.step} could not start`;
        break;
      }
      let w: Record<string, any> = {};
      // exec-wait answers still_running only when its own wait ran out; ask again, bounded
      for (let tries = 0; tries < 10; tries++) {
        w = (await deps.helper(["exec-wait", id, "--exec", bg.exec_id, "--timeout", String(timeout + 60)])).out;
        if (w.error !== "still_running" || now() > input.deadline + 60_000) break;
      }
      const t1 = now();
      c.state = w.state === "exited" ? (w.exit_code === 0 ? "exited" : "failed") : String(w.state ?? "error");
      c.exitCode = typeof w.exit_code === "number" ? w.exit_code : null;
      c.ok = w.state === "exited" && w.exit_code === 0;
      c.startedAt = typeof w.started_at === "string" ? w.started_at : iso(t0);
      c.finishedAt = typeof w.finished_at === "string" ? w.finished_at : iso(t1);
      c.durationMs = typeof w.duration_ms === "number" ? w.duration_ms : t1 - t0;
      c.commandSha256 = sha(c.command);
      c.stdoutSha256 = sha(String(w.stdout ?? ""));
      c.stderrSha256 = sha(String(w.stderr ?? ""));
      c.stdoutTruncated = w.stdout_truncated === true;
      c.stderrTruncated = w.stderr_truncated === true;
      c.roomReceiptId = w.room_receipt_id ?? null;
      // Cathedral may drop a finished command's output; then the hash is of "" and won't match its receipt
      if (w.output_evicted === true) c.note = "output evicted by Cathedral; the output hashes are of empty text";
      if (!c.ok) {
        c.note = c.state === "failed" ? `exited with ${c.exitCode}` : errText(w);
        failure = `${c.step} ${c.note}`;
      }
    }

    const status = (await deps.helper(["status", id])).out;
    if (status.ok) {
      room.image = status.image ?? room.image ?? null;
      room.imageDigest = status.image_digest ?? room.imageDigest ?? null;
      room.createReceiptId = status.receipt_id ?? room.createReceiptId ?? null;
      if (status.receipts && typeof status.receipts === "object") head = { count: status.receipts.count ?? null, n: status.receipts.head_n ?? null, sha256: status.receipts.head_sha256 ?? null, from: "status" };
    }
    room.createReceiptUrl = publicUrl(deps.apiUrl(), (status.ok ? status.receipt_url : null) ?? made.receipt_url ?? (room.createReceiptId ? `/v1/receipts/${room.createReceiptId}` : null));
    room.attestationUrl = room.hotel ? publicUrl(deps.apiUrl(), `/v1/hotels/${room.hotel}/attestation`) : null;
    const v = (await deps.helper(["verify", id])).out;
    verify = typeof v.ok !== "boolean" || (v.ok === false && !v.chain) ? { ok: null, checked: [], notChecked: strs(v.not_checked), error: errText(v) } : { ok: v.ok, checked: strs(v.checked), notChecked: strs(v.not_checked) };
    // The bundle is receipts and attestation material (Cathedral's chain, the guest's receipts,
    // the AMD report and certificates), no secrets. Fetched to a temp file, then written into the
    // workspace by this code, so a link planted there can't redirect the write.
    const evTmp = path.join(tmp, "evidence.json");
    const ev = (await deps.helper(["evidence", id, "--out", evTmp])).out;
    if (ev.ok && existsSync(evTmp)) {
      const file = path.join(certDir, `${input.runId}.evidence.json`);
      writeFresh(file, readFileSync(evTmp));
      Object.assign(evidence, { path: rel(input.ws, file), sha256: typeof ev.sha256 === "string" ? ev.sha256 : fileSha(file), bytes: statSync(file).size, schema: ev.schema ?? null });
    } else evidence.error = errText(ev);
  }
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const fenceFor = (s: string) => "`".repeat(Math.max(3, (s.match(/`+/g) ?? []).reduce((m, x) => Math.max(m, x.length + 1), 0)));
const code = (s: string) => "`" + cell(s).replace(/`/g, "'") + "`";

/** The certificate as Markdown: what ran, the room, the receipts, how to check it, and what it does and doesn't show. */
export function renderCertificate(c: Certificate): string {
  const verdict = { pass: "PASS: every command exited 0", fail: "FAIL: a command did not succeed", incomplete: "INCOMPLETE: the commands did not all run" }[c.result];
  const L: string[] = [];
  L.push("# Clean-machine certificate", "", `**${verdict}**`, "");
  L.push("## Repo and commit", "");
  L.push(`- Repo: ${code(c.repo.path)}${c.repo.remote ? ` (origin ${cell(c.repo.remote)})` : " (no origin remote)"}`);
  L.push(`- Commit: ${code(c.repo.commit)}`);
  L.push(`- Uploaded: \`git archive\` of that commit, ${c.repo.archiveBytes} bytes, sha256 ${code(c.repo.archiveSha256)}`);
  if (c.repo.uncommittedChanges) L.push(`- The working copy had ${c.repo.uncommittedChanges} uncommitted change${c.repo.uncommittedChanges === 1 ? "" : "s"}; they were not part of this test.`);
  L.push("", "## Commands", "", "Run in order in `/work/src`; the first that fails stops the rest.", "");
  L.push("| Step | Result | Exit code | Started | Finished | Duration | stdout sha256 | stderr sha256 | Room receipt |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const hash = (h: string | undefined, t?: boolean) => (h ? `${code(h)}${t ? " (output truncated; hash of the returned text)" : ""}` : "");
  for (const x of c.commands) {
    const res = x.ok ? "passed" : x.state === "not_run" ? "not run" : x.state === "failed" ? "failed" : cell(x.state);
    L.push(
      `| ${x.step} | ${res} | ${x.exitCode ?? ""} | ${x.startedAt ?? ""} | ${x.finishedAt ?? ""} | ${x.durationMs != null ? `${(x.durationMs / 1000).toFixed(1)} s` : ""} | ${hash(x.stdoutSha256, x.stdoutTruncated)} | ${hash(x.stderrSha256, x.stderrTruncated)} | ${x.roomReceiptId ? code(x.roomReceiptId) : ""} |`,
    );
  }
  for (const x of c.commands) {
    const f = fenceFor(x.command);
    L.push("", `${x.step}${x.note ? ` (${x.note})` : ""}${x.commandSha256 ? `, command sha256 ${code(x.commandSha256)}` : ""}:`, "", f, x.command, f);
  }
  L.push("", "Output hashes are sha256 of the output text as returned (UTF-8), the scope Cathedral's exec receipts bind (`output_hash_scope: returned-text-utf8`).");
  L.push("", "## Room", "");
  L.push(`- Sandbox: ${code(c.room.sandboxId)}, size ${c.room.size}${c.room.hotel ? `, host ${c.room.hotel}` : ""}`);
  L.push(`- Image: ${c.room.image ? code(c.room.image) : "not reported"}; digest ${c.room.imageDigest ? code(c.room.imageDigest) : "not reported"}`);
  L.push(`- Network: ${c.room.network === "closed" ? "closed" : `closed apart from ${c.room.allowHosts.join(", ")} (enforced inside the guest)`}`);
  L.push(`- Created: ${c.room.createdAt ?? "not reported"}; deleted: ${c.deleted ? "yes" : `NO (${cell(c.deleteError ?? "unknown")}); it ends at its lifetime`}`);
  if (c.room.maxSpendUsd) L.push(`- Room spend held: up to $${c.room.maxSpendUsd} (room time, separate from model spend)`);
  L.push("", "## Times", "", `- Started: ${c.startedAt}`, `- Finished: ${c.finishedAt}`);
  if (c.failure) L.push(`- Stopped early: ${cell(c.failure)}`);
  L.push("", "## Receipts", "");
  L.push(
    c.receiptHead.sha256
      ? `- Receipt chain head${c.receiptHead.from === "delete" ? " (after the delete)" : " (before the delete)"}: n = ${c.receiptHead.n}, sha256 ${code(c.receiptHead.sha256)}${c.receiptHead.count != null ? `, ${c.receiptHead.count} receipts` : ""}`
      : "- Receipt chain head: not available",
  );
  L.push(`- Create receipt (public, no account needed): ${c.room.createReceiptUrl ?? "not available"}`);
  if (c.room.attestationUrl) L.push(`- Host attestation (public, no account needed): ${c.room.attestationUrl}`);
  L.push(`- Verify (Cathedral's verify route): ${c.verify.ok === true ? "passed" : c.verify.ok === false ? "FAILED" : `not available${c.verify.error ? ` (${cell(c.verify.error)})` : ""}`}`);
  for (const x of c.verify.checked) L.push(`  - checked: ${cell(x)}`);
  L.push(
    c.evidence.path
      ? `- Evidence bundle: ${code(c.evidence.path)} (${c.evidence.bytes} bytes, sha256 ${code(c.evidence.sha256 ?? "")}). Taken before the room was deleted, so it ends before the delete receipt.`
      : `- Evidence bundle: not saved (${cell(c.evidence.error ?? "unknown")})`,
  );
  L.push("", "## How to check it yourself", "");
  L.push(
    `1. Get the evidence bundle. Only the room's owner can fetch it from Cathedral (\`ctcli sandbox evidence ${c.room.sandboxId} -o evidence.json\`); BitBull saved it as ${code(c.evidence.path ?? ".bitbull/certificates/<id>.evidence.json")} so the owner can share it.`,
    "2. Check it offline with ctcli (a release after 0.5.19, installed with the verify extra, `ctcli[verify]`):",
    "",
    "   ```",
    "   ctcli receipt verify --bundle evidence.json --cathedral-key <pinned receipt key, hex> --ark-sha256 <pinned AMD ARK sha256> --expected-measurement <measurement>",
    "   ```",
    "",
    "   The verdict is PASS, FAIL or NOT PROVEN (NOT PROVEN without the pinned key and ARK). Take the measurement from https://cathedral.computer/approved-measurements.json; without --expected-measurement the build is not checked.",
    `3. The public create receipt and the host attestation linked above need no account. Compare the command and output hashes here with the exec receipts in the bundle.${c.receiptHead.from === "delete" ? " The bundle was taken before the room was deleted, so its chain ends one receipt before the head above (the delete)." : ""}`,
  );
  L.push("", "## What this shows", "");
  L.push(
    `- These commands ran in a fresh Cathedral confidential sandbox at commit ${code(c.repo.commit)}, with the results above.`,
    "- The room's own receipts are signed by a key held by the host's guest, which that host's AMD SEV-SNP attestation report commits to. The offline verifier checks that link and the AMD certificate chain, and checks Cathedral's receipt chain against the pinned key.",
  );
  L.push("", "## What this does not show", "");
  L.push(
    "- That the code is safe or correct. Passing commands show only that they exited 0 here.",
    "- That the image digest above is the image that ran, unless the guest's create receipt carries it (open the public create receipt and compare its image_digest).",
    "- That the receipt chain is complete at its end: the head is not signed, so receipts cut from the tail would not show.",
    "- That the room had a machine to itself: rooms on one host share one guest and are kept apart by gVisor, not by hardware.",
    "- That every room receipt was kept: the guest's own receipts are those Cathedral kept, and gaps in their sequence are not checked.",
    "- Anything for receipts signed before the host last restarted: they can't be checked against its current attestation.",
    "- Anything Cathedral's verify did not check. It lists:",
    ...(c.verify.notChecked.length ? c.verify.notChecked.map((x) => `  - ${cell(x)}`) : ["  - (verify gave no list)"]),
  );
  L.push("", `<sub>BitBull clean-machine certificate ${c.id}</sub>`, "");
  return L.join("\n");
}

/** A few lines for the verdict prompt and the pull request. */
export function certificateSummary(c: Certificate): string[] {
  return [
    `Clean-machine test: **${c.result.toUpperCase()}** at ${code(c.repo.commit.slice(0, 12))} in a fresh confidential sandbox (${c.room.network === "closed" ? "network closed" : `network closed apart from ${c.room.allowHosts.join(", ")}`}).`,
    ...c.commands.map((x) => `- ${x.step}: ${x.ok ? "passed" : x.state === "not_run" ? "not run" : `${cell(x.state)}${x.exitCode != null ? ` (exit ${x.exitCode})` : ""}`}`),
    `- receipt chain head n=${c.receiptHead.n ?? "?"}; verify ${c.verify.ok === true ? "passed" : c.verify.ok === false ? "FAILED" : "not available"}${c.room.createReceiptUrl ? `; create receipt ${c.room.createReceiptUrl}` : ""}`,
  ];
}

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 400)).slice(0, 40) : []);
const rel = (ws: string, f: string) => path.relative(realpathSync(ws), f).split(path.sep).join("/");
