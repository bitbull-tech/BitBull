import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { LINKS_ROOT, listLinks } from "./links.js";

/**
 * Git clones inside a workspace: what the UI shows when you open a project's Repositories view.
 * Almost nothing here changes a repo; checkout, pull, commit and the rest go through the agent
 * in the chat, where they are visible and reviewable. The exceptions are the plumbing of where
 * a working copy comes from: Sync (fetch + fast-forward), pointing a copy at a new origin, and
 * making a working copy from a repo in one of the owner's linked folders.
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
 *  1. a scrubbed environment: nothing git spawns ever sees BitBull's secrets;
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
 * Environment for git: no BitBull secrets, no user config, no interactive prompts.
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

async function git(cwd: string, args: string[], opts: { timeout?: number; pre?: string[] } = {}): Promise<string> {
  const { stdout } = await run("git", [...GIT_SAFE_FLAGS, ...(opts.pre ?? []), ...args], {
    cwd,
    timeout: opts.timeout ?? 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

/**
 * Why a git command failed, in words. Node's message is the whole command line (all the -c
 * flags), which says nothing; what git itself said is on stderr.
 */
export function gitError(e: unknown): string {
  const err = e as { stderr?: unknown; killed?: boolean; message?: string };
  const said = typeof err?.stderr === "string" ? err.stderr : "";
  const lines = said
    .split("\n")
    .map((l) => l.replace(/^(fatal|error|remote|warning):\s*/i, "").trim())
    .filter(Boolean);
  const text = lines.join(" ");
  if (err?.killed) return "it took too long and was stopped";
  if (/repository .* not found|not found$/i.test(text)) return "there is no repository at that address any more (renamed, moved, or private). Point this copy at where it lives now with Change remote";
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(text)) return "that repository needs a sign-in, which this button doesn't use (it is private). Ask the agent to fetch it: it has your GitHub token";
  if (/CONNECT tunnel failed|403|Could not resolve host|Failed to connect/i.test(text)) return "the remote couldn't be reached from the sandbox (not on the network allowlist, or offline)";
  if (/dubious ownership/i.test(text)) return "git won't read that folder because another user owns it";
  if (/does not appear to be a git repository/i.test(text)) return "that isn't a git repository";
  return clean(text || (err?.message ?? String(e)).replace(/^Command failed: git .*$/m, "git failed"), 200);
}

// ---------- where a working copy comes from ----------

export interface RepoSource {
  kind: "linked" | "url";
  /** what git is given: an absolute path under /links, or an https address */
  url: string;
  /** how it is shown: links/<name>/<repo>, or the address */
  label: string;
  /** a folder name for a copy of it */
  name: string;
}

/** Repos in the owner's linked folders (a few levels deep), as "links/<name>/<path>". */
export function linkedRepos(): Array<{ ref: string; name: string }> {
  const out: Array<{ ref: string; name: string }> = [];
  for (const l of listLinks()) {
    for (const rel of findRepos(path.join(LINKS_ROOT, l.name))) {
      const ref = rel === "." ? `links/${l.name}` : `links/${l.name}/${rel}`;
      out.push({ ref, name: rel === "." ? l.name : path.basename(rel) });
    }
  }
  return out;
}

/**
 * What the owner typed or picked → something git can be pointed at, or why not. Two kinds only:
 * a repo inside a linked folder (links/<name>/…), and an https address with no sign-in in it.
 */
export function resolveSource(input: string): RepoSource | { error: string } {
  const s = input.trim();
  if (!s) return { error: "Say where it is: a linked repo (links/…) or an https address." };
  if (/^https:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return { error: "That isn't an address." };
    }
    if (u.username || u.password) return { error: "Leave sign-in details out of the address: a token in a remote ends up in the repo's config." };
    if (!/^[A-Za-z0-9.-]+$/.test(u.hostname) || u.search || u.hash || !/^\/[A-Za-z0-9._~/-]+$/.test(u.pathname) || u.pathname.includes("..")) return { error: "That address has parts a git remote shouldn't (a query, a fragment or odd characters)." };
    const name = path.basename(u.pathname).replace(/\.git$/i, "");
    if (!name) return { error: "That address doesn't name a repository." };
    return { kind: "url", url: `https://${u.host}${u.pathname}`, label: `https://${u.host}${u.pathname}`, name };
  }
  // owner/name is GitHub, as everywhere else
  if (/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(s) && !s.startsWith("links/")) {
    const name = s.split("/")[1].replace(/\.git$/i, "");
    return { kind: "url", url: `https://github.com/${s.replace(/\.git$/i, "")}.git`, label: `https://github.com/${s.replace(/\.git$/i, "")}.git`, name };
  }
  const m = /^\/?links\/([a-z0-9][a-z0-9-]{0,39})(?:\/(.*))?$/.exec(s.replace(/\\/g, "/").replace(/\/+$/, ""));
  if (!m) return { error: "Give a repo in a linked folder (links/<folder>/<repo>), owner/name on GitHub, or an https address." };
  const link = listLinks().find((l) => l.name === m[1]);
  if (!link) return { error: `There is no linked folder called "${m[1]}". Link it under Settings → Folders first.` };
  const sub = (m[2] ?? "").split("/").filter((x) => x && x !== "." && x !== "..");
  const root = path.join(LINKS_ROOT, link.name);
  const abs = path.join(root, ...sub);
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { error: "That path leaves the linked folder." };
  } catch {
    return { error: `"${s}" isn't in that linked folder.` };
  }
  if (!existsSync(path.join(abs, ".git"))) return { error: `"${s}" isn't a git repository (no .git there).` };
  return { kind: "linked", url: abs, label: ["links", link.name, ...sub].join("/"), name: sub.at(-1) ?? link.name };
}

/** git refuses a repo another user owns; a linked folder is the owner's own, mounted under another uid. */
const trustLinked = (url: string | null | undefined) => (url && path.isAbsolute(url) && (url === LINKS_ROOT || url.startsWith(LINKS_ROOT + path.sep)) ? ["-c", `safe.directory=${url}`, "-c", `safe.directory=${path.join(url, ".git")}`] : []);

const safeFolder = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name) && !name.endsWith(".") && name.toLowerCase() !== ".git";

/** A linked repo's own https origin (GitHub, usually) is kept on the copy as the remote "upstream", without any sign-in in it. */
async function keepUpstream(dir: string, src: RepoSource): Promise<string> {
  if (src.kind !== "linked") return "";
  try {
    const theirs = (await git(src.url, ["config", "--get", "remote.origin.url"], { pre: trustLinked(src.url) })).trim();
    const up = resolveSource(theirs.replace(/\/\/[^@/]+@/, "//"));
    if ("error" in up || up.kind !== "url") return "";
    const remotes = (await git(dir, ["remote"])).split("\n").map((x) => x.trim());
    if (remotes.includes("upstream")) return "";
    await git(dir, ["remote", "add", "upstream", up.url]);
    return ` Its own origin (${up.label}) is kept as the remote "upstream".`;
  } catch {
    return ""; // no origin of its own, or not readable: the copy is still good
  }
}

/**
 * Point a working copy at a new origin (the repo moved or was renamed, or it should follow the
 * owner's own folder), fetch from it, and optionally rename the folder to match. Uncommitted work
 * and local branches are not touched.
 */
export async function setRemote(ws: string, rel: string, sourceInput: string, rename = false): Promise<{ ok: boolean; message: string; path?: string }> {
  const dir = containedDir(ws, rel);
  if (!dir) return { ok: false, message: "That path leaves the workspace through a link; refusing to change it." };
  const unsafe = await execCapableConfig(dir);
  if (unsafe.length) return { ok: false, message: UNSAFE_REPO(unsafe) };
  const src = resolveSource(sourceInput);
  if ("error" in src) return { ok: false, message: src.error };
  try {
    const remotes = (await git(dir, ["remote"])).split("\n").map((x) => x.trim());
    await git(dir, remotes.includes("origin") ? ["remote", "set-url", "origin", src.url] : ["remote", "add", "origin", src.url]);
  } catch (e) {
    return { ok: false, message: `Could not set the remote: ${gitError(e)}.` };
  }
  let note = "";
  try {
    await git(dir, ["fetch", "--quiet", "--prune", "origin"], { timeout: 120_000, pre: trustLinked(src.url) });
    // follow the same-named branch there, when there is one
    const branch = (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
    if (branch && /^[A-Za-z0-9._/-]{1,200}$/.test(branch)) {
      const has = await git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).then(
        () => true,
        () => false,
      );
      if (has) await git(dir, ["branch", "--quiet", `--set-upstream-to=origin/${branch}`, branch]);
      else note = ` There is no branch called ${branch} there, so this one follows nothing yet.`;
    }
  } catch (e) {
    return { ok: false, message: `The remote is now ${src.label}, but fetching from it failed: ${gitError(e)}.` };
  }
  note += await keepUpstream(dir, src);
  let newRel = rel;
  if (rename && rel !== "." && src.name !== path.basename(rel)) {
    const target = path.join(path.dirname(dir), src.name);
    if (!safeFolder(src.name)) note += ` The folder wasn't renamed: "${src.name}" isn't a usable folder name.`;
    else if (existsSync(target)) note += ` The folder wasn't renamed: ${src.name} already exists here.`;
    else {
      try {
        renameSync(dir, target);
        newRel = path.relative(ws, target).split(path.sep).join("/");
        note += ` The folder is now ${newRel}.`;
      } catch (e) {
        note += ` The folder couldn't be renamed (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
  }
  return { ok: true, message: `Now follows ${src.label}.${note}`, path: newRel };
}

/**
 * Make a working copy, in this workspace, of a repo in one of the owner's linked folders. The
 * copy's origin is that folder, so Sync brings in whatever the owner has committed there. If the
 * owner's repo has an https origin of its own (GitHub), it is added as the remote "upstream".
 * GitHub addresses are not cloned here: the agent does that in the chat, with the owner's token.
 */
export async function addRepo(ws: string, sourceInput: string): Promise<{ ok: boolean; message: string; path?: string }> {
  const src = resolveSource(sourceInput);
  if ("error" in src) return { ok: false, message: src.error };
  if (src.kind !== "linked") return { ok: false, message: "From here, working copies are made from repos in your linked folders. For a GitHub address, ask the agent to clone it." };
  if (!safeFolder(src.name)) return { ok: false, message: `"${src.name}" isn't a usable folder name.` };
  let root: string;
  try {
    root = realpathSync(ws);
  } catch {
    return { ok: false, message: "This workspace doesn't exist yet." };
  }
  const dest = path.join(root, src.name);
  if (existsSync(dest)) return { ok: false, message: `There is already a ${src.name} in this workspace. Use Change remote on it, or remove it first.` };
  try {
    await git(root, ["clone", "--quiet", "--no-hardlinks", "--origin", "origin", "--", src.url, dest], { timeout: 180_000, pre: trustLinked(src.url) });
  } catch (e) {
    return { ok: false, message: `Could not copy ${src.label}: ${gitError(e)}.` };
  }
  const note = await keepUpstream(dest, src);
  return { ok: true, message: `Working copy made at ${src.name}, following ${src.label}. Sync brings in what you commit there.${note}`, path: src.name };
}

const UNSAFE_REPO = (keys: string[]) =>
  `Not inspected: this clone's own git config sets ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ` and ${keys.length - 4} more` : ""}, which git would run as a command. ` +
  `That is how a hostile repository attacks the machine inspecting it. Look at .git/config yourself before trusting this clone.`;

/**
 * The clone must be a real directory inside the real workspace. A lexical prefix check passes a
 * symlinked folder that points anywhere on disk, and every git call below then runs there — and
 * `sync` fetches over the network from whatever remote it finds. (2026-11 swarm.)
 */
function containedDir(ws: string, rel: string): string | null {
  const dir = rel === "." ? ws : path.join(ws, rel);
  try {
    const root = realpathSync(path.resolve(ws));
    const real = realpathSync(dir);
    if (real !== root && !real.startsWith(root + path.sep)) return null;
    return dir;
  } catch {
    return null;
  }
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
  const dir = containedDir(ws, rel);
  if (!dir) return { ok: false, message: "That path leaves the workspace through a link; refusing to fetch into it." };
  const unsafe = await execCapableConfig(dir);
  if (unsafe.length) return { ok: false, message: UNSAFE_REPO(unsafe) };
  const before = await inspectRepo(ws, rel);
  if (before.error) return { ok: false, message: before.error };
  if (!before.upstream) return { ok: false, message: "This branch has no upstream to sync from. Set one, or use the agent." };
  if (!fetchOnly && (before.changed || before.staged || before.conflicts)) {
    return { ok: false, message: "Uncommitted changes here: sync would overwrite them. Ask the agent to commit or stash first." };
  }
  try {
    const origin = (await git(dir, ["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
    await git(dir, ["fetch", "--quiet", "--prune"], { timeout: 120_000, pre: trustLinked(origin) });
  } catch (e) {
    return { ok: false, message: `Could not fetch: ${gitError(e)}.` };
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
    return { ok: false, message: `Fetched, but could not fast-forward: ${gitError(e)}.` };
  }
  return { ok: true, message: `Fast-forwarded ${after.behind} commit${after.behind === 1 ? "" : "s"} to ${after.upstream}.` };
}

export async function repoDiffStat(ws: string, rel: string, base?: string): Promise<string> {
  const dir = containedDir(ws, rel);
  if (!dir) return "(that path leaves the workspace through a link; refusing to read it)";
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
