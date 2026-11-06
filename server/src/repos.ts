import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Git clones inside a workspace, read-only: what the UI shows when you open a project's
 * Repositories view. Nothing here changes a repo; every action (checkout, pull, commit…)
 * goes through the agent in the chat, where it is visible and reviewable.
 *
 * Everything is read with `git` itself from the clone's own directory, with a timeout and
 * the output size capped, and the clone is agent-written, so results are data to display,
 * never paths or commands to act on.
 */
const run = promisify(execFile);

/**
 * A clone is attacker-controlled: the agent clones whatever it is asked to, and an upload can
 * plant a `.git` folder. Git executes commands named in the repo's OWN config — `core.fsmonitor`
 * fires on `git status`, and a `filter.<x>.clean` referenced from the repo's `.gitattributes`
 * fires too — which would run as this server process. Three layers, because no single one holds:
 *
 *  1. a scrubbed environment: nothing git spawns ever sees BitBob's secrets;
 *  2. `-c` overrides for every exec knob that can be named up front;
 *  3. a refusal when the repo's own config defines any exec-capable key, which is the only way
 *     to cover `filter.*.clean` / `diff.*.textconv`, whose driver names are arbitrary.
 */
const GIT_SAFE_FLAGS = [
  "--no-optional-locks",
  "-c",
  "core.quotepath=off",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "core.editor=true",
  "-c",
  "core.sshCommand=false",
  "-c",
  "core.gitProxy=",
  "-c",
  "core.askPass=",
  "-c",
  "diff.external=",
  "-c",
  "credential.helper=",
  "-c",
  "uploadpack.packObjectsHook=",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "gpg.program=false",
];

/** Config keys whose value git runs as a command. Matched case-insensitively against key names. */
const EXEC_KEY = /^(core\.(fsmonitor|hookspath|sshcommand|pager|editor|gitproxy|askpass)|diff\.external|credential\.(helper|.*\.helper)|uploadpack\.packobjectshook|gpg\..*program|sequence\.editor|.*\.textconv|filter\..*\.(clean|smudge|process)|alias\..*|ssh\.variant|init\.templatedir)$/i;

/**
 * Environment for git: no BitBob secrets, no user config, no interactive prompts.
 * The null device (never a plantable path) stands in for the global config on both platforms;
 * Windows needs a handful of ambient variables to start a process at all, and none are secrets.
 */
function gitEnv() {
  const win = process.platform === "win32";
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: win ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file:https",
  };
  if (win) {
    for (const k of ["SystemRoot", "SYSTEMROOT", "SystemDrive", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
  } else {
    env.HOME = "/nonexistent";
  }
  return env;
}

/**
 * Does this clone's own config define a key git would execute? `git config --list` only reads
 * (it runs nothing), and it resolves `include.path`, which a hand parser would miss.
 * Returns the offending key names, or [] when the repo is safe to inspect.
 */
export async function execCapableConfig(dir: string): Promise<string[]> {
  try {
    const { stdout } = await run("git", ["config", "--local", "--list", "--name-only", "-z"], {
      cwd: dir,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: gitEnv(),
    });
    return [...new Set(stdout.split("\0").filter((k) => k && EXEC_KEY.test(k)))];
  } catch (e) {
    // Fail CLOSED. Returning "nothing dangerous here" because the check itself broke would run
    // git in a repo we could not vet — the exact thing this gate exists to prevent.
    return [`unreadable config (${clean(e instanceof Error ? e.message : String(e), 100)})`];
  }
}

export interface RepoInfo {
  /** workspace-relative folder */
  path: string;
  name: string;
  branch: string | null;
  /** detached HEAD: the short commit */
  detached: boolean;
  ahead: number;
  behind: number;
  upstream: string | null;
  /** uncommitted changes */
  changed: number;
  untracked: number;
  staged: number;
  conflicts: number;
  remote: string | null;
  head: { sha: string; subject: string; author: string; when: string } | null;
  branches: { name: string; current: boolean; remote: boolean; upstream?: string; ahead?: number; behind?: number; last?: string }[];
  stashes: number;
  error?: string;
}

const MAX_DEPTH = 3;
const SKIP = new Set(["node_modules", ".git", ".claude", ".opencode", ".venv", "venv", "dist", "build", "target", "__pycache__", ".cache", "archive"]);

/** Find clones under a workspace (a .git folder, or a .git file for worktrees), a few levels deep. */
export function findRepos(ws: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) {
      out.push(path.relative(ws, dir).split(path.sep).join("/") || ".");
      return; // submodules inside count as part of this repo
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(ws, 0);
  return out.sort();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", [...GIT_SAFE_FLAGS, ...args], {
    cwd,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

const UNSAFE_REPO = (keys: string[]) =>
  `Not inspected: this clone's own git config sets ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ` and ${keys.length - 4} more` : ""}, which git would run as a command. ` +
  `That is how a hostile repository attacks the machine inspecting it. Look at .git/config yourself before trusting this clone.`;

const clean = (s: string, n = 200) => s.replace(/[\u0000-\u001f]/g, " ").slice(0, n);

/** Everything the Repositories view shows for one clone. Never throws: errors are reported in the row. */
export async function inspectRepo(ws: string, rel: string): Promise<RepoInfo> {
  const dir = rel === "." ? ws : path.join(ws, rel);
  const info: RepoInfo = {
    path: rel,
    name: rel === "." ? path.basename(ws) : path.basename(rel),
    branch: null,
    detached: false,
    ahead: 0,
    behind: 0,
    upstream: null,
    changed: 0,
    untracked: 0,
    staged: 0,
    conflicts: 0,
    remote: null,
    head: null,
    branches: [],
    stashes: 0,
  };
  try {
    const unsafe = await execCapableConfig(dir);
    if (unsafe.length) {
      info.error = UNSAFE_REPO(unsafe);
      return info;
    }
    // status --porcelain=v2 --branch: machine-readable and stable
    const st = await git(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
    for (const line of st.split("\n")) {
      if (line.startsWith("# branch.head ")) {
        const h = line.slice(14).trim();
        if (h === "(detached)") info.detached = true;
        else info.branch = clean(h, 120);
      } else if (line.startsWith("# branch.upstream ")) info.upstream = clean(line.slice(18).trim(), 120);
      else if (line.startsWith("# branch.ab ")) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) {
          info.ahead = Number(m[1]);
          info.behind = Number(m[2]);
        }
      } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
        const xy = line.slice(2, 4);
        if (xy[0] !== ".") info.staged++;
        if (xy[1] !== ".") info.changed++;
      } else if (line.startsWith("u ")) info.conflicts++;
      else if (line.startsWith("? ")) info.untracked++;
    }
    try {
      const log = await git(dir, ["log", "-1", "--format=%h%x00%s%x00%an%x00%cr"]);
      const [sha, subject, author, when] = log.trim().split("\u0000");
      if (sha) info.head = { sha, subject: clean(subject ?? "", 160), author: clean(author ?? "", 80), when: clean(when ?? "", 40) };
      if (info.detached) info.branch = sha ?? null;
    } catch {
      /* no commits yet */
    }
    try {
      const remotes = await git(dir, ["remote", "get-url", "origin"]);
      // never show credentials embedded in a URL
      info.remote = clean(remotes.trim().replace(/\/\/[^@/]+@/, "//"), 200) || null;
    } catch {
      /* no origin */
    }
    try {
      const refs = await git(dir, [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:relative)",
        "refs/heads",
        "refs/remotes",
      ]);
      for (const line of refs.split("\n").filter(Boolean).slice(0, 200)) {
        const [name, headMark, upstream, track, last] = line.split("\u0000");
        if (!name || name.endsWith("/HEAD")) continue;
        const remote = await isRemoteRef(dir, name);
        const b: RepoInfo["branches"][number] = { name: clean(name, 120), current: headMark === "*", remote, last: clean(last ?? "", 40) };
        if (upstream) b.upstream = clean(upstream, 120);
        const a = /ahead (\d+)/.exec(track ?? "");
        const bh = /behind (\d+)/.exec(track ?? "");
        if (a) b.ahead = Number(a[1]);
        if (bh) b.behind = Number(bh[1]);
        info.branches.push(b);
      }
    } catch {
      /* ignore */
    }
    try {
      const stashes = await git(dir, ["stash", "list"]);
      info.stashes = stashes.split("\n").filter(Boolean).length;
    } catch {
      /* ignore */
    }
  } catch (e) {
    info.error = clean(e instanceof Error ? e.message : String(e), 300);
  }
  return info;
}

const remoteRefCache = new Map<string, Set<string>>();
async function isRemoteRef(dir: string, name: string) {
  let set = remoteRefCache.get(dir);
  if (!set) {
    set = new Set((await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"])).split("\n").filter(Boolean));
    remoteRefCache.set(dir, set);
    setTimeout(() => remoteRefCache.delete(dir), 5000).unref();
  }
  return set.has(name);
}

export async function listRepos(ws: string): Promise<RepoInfo[]> {
  if (!existsSync(ws) || !statSync(ws).isDirectory()) return [];
  const found = findRepos(ws);
  return Promise.all(found.map((rel) => inspectRepo(ws, rel)));
}

/** A branch's diff summary against the working tree or another ref, for the view's "what changed" (read-only). */
/**
 * Fetch, then fast-forward the clone onto its upstream. The one write this module does, and
 * deliberately the narrowest useful one: no merge commits, no rebase, nothing when the tree is
 * dirty or the branch has diverged. The workspace clone is a *copy* for the agent to read and
 * work in — it is not what the server runs — so bringing it level with origin is routine, and
 * anything that needs judgement is left to the agent in the chat.
 *
 * `git fetch` talks to the network, so the hostile-clone gate matters even more here than for a
 * read: a repo whose own config names exec-capable keys is refused before git runs at all.
 */
export async function syncRepo(ws: string, rel: string, fetchOnly = false): Promise<{ ok: boolean; message: string }> {
  const dir = rel === "." ? ws : path.join(ws, rel);
  const unsafe = await execCapableConfig(dir);
  if (unsafe.length) return { ok: false, message: UNSAFE_REPO(unsafe) };
  const before = await inspectRepo(ws, rel);
  if (before.error) return { ok: false, message: before.error };
  if (!before.upstream) return { ok: false, message: "This branch has no upstream to sync from. Set one, or use the agent." };
  if (!fetchOnly && (before.changed || before.staged || before.conflicts)) {
    return { ok: false, message: "Uncommitted changes here: sync would overwrite them. Ask the agent to commit or stash first." };
  }
  try {
    await git(dir, ["fetch", "--quiet", "--prune"]);
  } catch (e) {
    return { ok: false, message: `Could not fetch: ${clean(e instanceof Error ? e.message : String(e), 200)}` };
  }
  const after = await inspectRepo(ws, rel);
  // fetchOnly: just make `behind` truthful, so a caller can warn before spending anything.
  if (fetchOnly) {
    return { ok: true, message: after.behind ? `${after.behind} behind ${after.upstream ?? "origin"}.` : `Level with ${after.upstream ?? "origin"}.` };
  }
  if (!after.behind) return { ok: true, message: `Already level with ${after.upstream ?? "origin"}.` };
  if (after.ahead) {
    return { ok: false, message: `This branch is ${after.ahead} ahead and ${after.behind} behind ${after.upstream}: it has diverged, so a fast-forward is not possible. Ask the agent.` };
  }
  try {
    await git(dir, ["merge", "--ff-only", "--quiet", "@{upstream}"]);
  } catch (e) {
    return { ok: false, message: `Fetched, but could not fast-forward: ${clean(e instanceof Error ? e.message : String(e), 200)}` };
  }
  return { ok: true, message: `Fast-forwarded ${after.behind} commit${after.behind === 1 ? "" : "s"} to ${after.upstream}.` };
}

export async function repoDiffStat(ws: string, rel: string, base?: string): Promise<string> {
  const dir = rel === "." ? ws : path.join(ws, rel);
  const unsafe = await execCapableConfig(dir);
  if (unsafe.length) return `(${UNSAFE_REPO(unsafe)})`;
  const safeBase = base && /^[A-Za-z0-9._/@^~-]{1,120}$/.test(base) && !base.startsWith("-") ? base : null;
  const args = safeBase ? ["diff", "--stat=100", `${safeBase}...HEAD`] : ["diff", "--stat=100", "HEAD"];
  try {
    return clean(await git(dir, args), 20_000);
  } catch (e) {
    return `(could not diff: ${clean(e instanceof Error ? e.message : String(e), 200)})`;
  }
}
