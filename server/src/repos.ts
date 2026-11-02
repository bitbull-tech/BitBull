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
      out.push(path.relative(ws, dir) || ".");
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
  const { stdout } = await run("git", ["--no-optional-locks", "-c", "core.quotepath=off", ...args], {
    cwd,
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  return stdout;
}

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
export async function repoDiffStat(ws: string, rel: string, base?: string): Promise<string> {
  const dir = rel === "." ? ws : path.join(ws, rel);
  const safeBase = base && /^[A-Za-z0-9._/@^~-]{1,120}$/.test(base) && !base.startsWith("-") ? base : null;
  const args = safeBase ? ["diff", "--stat=100", `${safeBase}...HEAD`] : ["diff", "--stat=100", "HEAD"];
  try {
    return clean(await git(dir, args), 20_000);
  } catch (e) {
    return `(could not diff: ${clean(e instanceof Error ? e.message : String(e), 200)})`;
  }
}
