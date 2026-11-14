/**
 * Changing files in a linked folder, with the owner's say-so each time.
 *
 * A linked folder is the owner's real folder on their computer, mounted read-only: the kernel
 * refuses every write from the sandbox, and that does not change. When the agent wants to change
 * files there it writes the new versions in its own workspace and calls propose_folder_changes
 * (BitBull's MCP server). This module checks the proposal, copies the files to a staging folder,
 * works out what would change, and shows the owner a card: the files, the diff, and two ways to
 * accept it.
 *
 *   Apply to the folder   the link helper on the owner's PC copies the staged files in
 *   Put it on a branch    when the files sit in a git repo: the helper makes a new branch
 *                         bitbull/<name> from the repo's current commit and leaves the working
 *                         files alone. Offered first, as the safer one.
 *
 * Who does the writing: never this server and never the agent. The owner's browser, on the PC,
 * asks the link helper (scripts/bitbull-wsl/link-helper.ps1), which runs on Windows as the owner,
 * only for folders the owner allowed changes in (a Windows dialog, listed in Settings → Folders),
 * and with its own copy of the rules below (folder-apply.ps1). So:
 *
 *  - an unattended run (a schedule, a Telegram message) can't change a folder: nobody is at the
 *    browser to approve, and the tool refuses to propose from one anyway;
 *  - what is applied is what was shown: each staged file's SHA-256 goes to the helper with the
 *    approval, and a file that changed since is refused;
 *  - files that would run on the PC without the owner choosing to (git hooks and config, editor
 *    tasks, CI workflows, shell start-up files, programs) and .env files are never written,
 *    whoever approves.
 *
 * Proposals live in memory and end when BitBull restarts, like network requests: anything kept
 * in the data folder could be edited by the agent.
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { record } from "./activity.js";
import { config } from "./config.js";
import { LINKS_ROOT, listLinks } from "./links.js";

// ---------- what may never be written (the same rules as folder-apply.ps1; a test keeps them in step) ----------

const PROTECTED_DIRS = new Set([".git", ".githooks", ".husky", ".vscode", ".idea", ".devcontainer"]);
const PROTECTED_FILES = new Set([".gitconfig", ".envrc", ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin", "desktop.ini", "autorun.inf"]);
const PROTECTED_EXT = new Set([".exe", ".dll", ".msi", ".scr", ".com", ".pif", ".lnk", ".url", ".sys", ".cpl"]);
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const DEVICES = new Set(["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])]);

/** For the test that keeps these lists the same as folder-apply.ps1. */
export const _protected = { dirs: PROTECTED_DIRS, files: PROTECTED_FILES, ext: PROTECTED_EXT, envTemplates: ENV_TEMPLATES };

/** null when the path (forward slashes, relative to the linked folder) may be written; else why not. */
export function protectedReason(rel: string): string | null {
  if (!rel) return "empty path";
  if (rel.length > 400) return "path too long";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(rel)) return "control character in the path";
  if (rel.includes("\\") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return "not a path inside the folder";
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const low = p.toLowerCase();
    if (p === "" || p === "." || p === "..") return "not a path inside the folder";
    if (p.includes(":")) return "a colon in a name (alternate data stream)";
    if (/[<>"|?*]/.test(p)) return "a character Windows does not allow in names";
    if (p.endsWith(".") || p.endsWith(" ")) return "a name ending in a dot or a space";
    if (/~\d/.test(p)) return "a short (8.3) name, which could stand for a protected folder";
    if (DEVICES.has(low.split(".")[0])) return "a Windows device name";
    if (PROTECTED_DIRS.has(low)) return `${p} is protected (it can run things on the owner's computer)`;
    if (low === ".github" && parts[i + 1]?.toLowerCase() === "workflows") return ".github/workflows is protected (CI runs it)";
  }
  const name = parts[parts.length - 1].toLowerCase();
  if (PROTECTED_FILES.has(name)) return `${name} is protected (it runs when a shell or Explorer opens)`;
  if ((name === ".env" || name.startsWith(".env.")) && !ENV_TEMPLATES.has(name)) return `${name} is protected (it holds secrets)`;
  const dot = name.lastIndexOf(".");
  if (dot >= 0 && PROTECTED_EXT.has(name.slice(dot))) return "programs and shortcuts are not written";
  return null;
}

// ---------- a small line diff, for the owner to read ----------

const MAX_DIFF_LINES = 1500;

/** Lines added and removed, and a unified-style diff with two lines of context (capped). */
export function lineDiff(before: string, after: string): { added: number; removed: number; diff?: string } {
  // lines as an editor counts them: a final newline doesn't make an extra empty line
  const lines = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
  const a = lines(before);
  const b = lines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return { added: b.length, removed: a.length };
  // longest common subsequence, table of lengths
  const w = b.length + 1;
  const t = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  const ops: Array<{ k: " " | "+" | "-"; s: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ k: " ", s: a[i++] }), j++;
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ k: "-", s: a[i++] });
    else ops.push({ k: "+", s: b[j++] });
  }
  while (i < a.length) ops.push({ k: "-", s: a[i++] });
  while (j < b.length) ops.push({ k: "+", s: b[j++] });
  const added = ops.filter((o) => o.k === "+").length;
  const removed = ops.filter((o) => o.k === "-").length;
  // keep changed lines and two lines either side
  const keep = new Uint8Array(ops.length);
  ops.forEach((o, n) => {
    if (o.k !== " ") for (let d = -2; d <= 2; d++) if (n + d >= 0 && n + d < ops.length) keep[n + d] = 1;
  });
  const out: string[] = [];
  let gap = false;
  for (let n = 0; n < ops.length && out.length < 400; n++) {
    if (!keep[n]) {
      gap = true;
      continue;
    }
    if (gap && out.length) out.push("…");
    gap = false;
    out.push(`${ops[n].k}${ops[n].s.slice(0, 300)}`);
  }
  return { added, removed, diff: out.join("\n") };
}

// ---------- proposals ----------

export interface ChangeFile {
  /** relative to the linked folder */
  path: string;
  status: "new" | "modified";
  size: number;
  sha256: string;
  added: number;
  removed: number;
  /** text files only, and not too long */
  diff?: string;
}
export type ChangeStatus = "pending" | "applied" | "branch" | "declined" | "failed" | "expired";
export interface ChangeSet {
  id: string;
  link: string;
  summary: string;
  sessionId?: string;
  sessionTitle?: string;
  files: ChangeFile[];
  deletes: string[];
  /** the git repo (relative to the linked folder, "" = the folder itself) every path sits in, if there is one */
  repo: string | null;
  /** the branch name offered for "put it on a branch" */
  branch: string;
  /** where the staged files are, as the owner's PC sees the data folder (null: not known here) */
  hostStaging: string | null;
  status: ChangeStatus;
  message?: string;
  createdAt: string;
  decidedAt?: string;
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const STAGING_ROOT = path.join(config.dataDir, "folder-changes");
const WAIT_MS = 5 * 60_000;
const KEEP = 50;

const sets: ChangeSet[] = [];
const waiters = new Map<string, Array<(s: ChangeSet) => void>>();
const subscribers = new Set<() => void>();
export const onFolderChange = (fn: () => void) => (subscribers.add(fn), () => subscribers.delete(fn));
const changed = () => subscribers.forEach((f) => f());

// staged files from a previous run belong to proposals that no longer exist
try {
  rmSync(STAGING_ROOT, { recursive: true, force: true });
} catch {
  /* nothing staged */
}

const stagingOf = (id: string) => path.join(STAGING_ROOT, id);
function hostPath(abs: string): string | null {
  const host = process.env.BITBULL_HOST_DATA_DIR || "";
  return host && abs.startsWith(config.dataDir) ? host.replace(/[\\/]+$/, "") + abs.slice(config.dataDir.length) : null;
}

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "") || "changes";

/** The repo all the paths sit in, looking only at the read-only link: "" for the folder itself, null for none or several. */
export function repoOf(linkDir: string, rels: string[]): string | null {
  let found: string | null = null;
  for (const rel of rels) {
    const parts = rel.split("/");
    let hit: string | null = null;
    for (let n = parts.length - 1; n >= 0; n--) {
      const sub = parts.slice(0, n).join("/");
      if (existsSync(path.join(linkDir, sub, ".git"))) {
        hit = sub;
        break;
      }
    }
    if (hit === null) return null;
    if (found === null) found = hit;
    else if (found !== hit) return null;
  }
  return found;
}

export interface Proposal {
  link: string;
  summary: string;
  /** to: path in the linked folder; from: path in the workspace holding the new content */
  files: Array<{ to: string; from: string }>;
  deletes: string[];
  workspace: string;
  sessionId?: string;
  sessionTitle?: string;
}

/** Check a proposal and stage it. The text is what the agent is told. */
export function propose(p: Proposal): { ok: boolean; text: string; set?: ChangeSet } {
  const no = (text: string) => ({ ok: false, text });
  const link = listLinks().find((l) => l.name === p.link);
  if (!link) return no(`There is no linked folder called "${p.link}". Linked folders: ${listLinks().map((l) => l.name).join(", ") || "none"}.`);
  if (!p.files.length && !p.deletes.length) return no("Nothing to change: give files and/or deletes.");
  if (p.files.length + p.deletes.length > MAX_FILES) return no(`Too many files in one proposal (${MAX_FILES} at most). Split it.`);
  const linkDir = path.join(LINKS_ROOT, link.name);
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(new RegExp(`^/?links/${link.name}/`), "");
  const refused: string[] = [];
  const seen = new Set<string>();
  const id = randomUUID();
  const staging = stagingOf(id);
  const files: ChangeFile[] = [];
  let total = 0;
  const ws = realpathSync(p.workspace);
  try {
    for (const f of p.files) {
      const to = norm(f.to);
      const why = protectedReason(to);
      if (why) {
        refused.push(`${to || f.to}: ${why}`);
        continue;
      }
      if (seen.has(to.toLowerCase())) return no(`${to} is listed twice.`);
      seen.add(to.toLowerCase());
      // the new content: a regular file inside this chat's workspace, not a link to somewhere else
      const src = path.resolve(ws, f.from.replace(/\\/g, "/"));
      let st;
      try {
        st = lstatSync(src);
      } catch {
        return no(`"${f.from}" isn't a file in your workspace. Write the new version there first, then propose it.`);
      }
      if (!st.isFile()) return no(`"${f.from}" isn't a regular file.`);
      const real = realpathSync(src);
      if (!(real === ws || real.startsWith(ws + path.sep))) return no(`"${f.from}" is outside your workspace.`);
      if (st.size > MAX_FILE_BYTES) return no(`${to} is over ${MAX_FILE_BYTES / 1024 / 1024} MB: too big to put in a folder this way.`);
      total += st.size;
      if (total > MAX_TOTAL_BYTES) return no(`Over ${MAX_TOTAL_BYTES / 1024 / 1024} MB in one proposal. Split it.`);
      const dest = path.join(staging, to);
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(real, dest);
      const buf = readFileSync(dest);
      const cur = path.join(linkDir, to);
      let before: Buffer | null = null;
      try {
        if (statSync(cur).isFile()) before = readFileSync(cur);
      } catch {
        /* a new file */
      }
      if (before && before.equals(buf)) {
        rmSync(dest, { force: true });
        continue; // already the same: nothing to do for this one
      }
      const text = isText(buf) && (!before || isText(before));
      const d = text ? lineDiff(before ? before.toString("utf8") : "", buf.toString("utf8")) : { added: 0, removed: 0 };
      files.push({ path: to, status: before ? "modified" : "new", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), added: d.added, removed: before ? d.removed : 0, diff: d.diff });
    }
    const deletes: string[] = [];
    for (const raw of p.deletes) {
      const to = norm(raw);
      const why = protectedReason(to);
      if (why) {
        refused.push(`${to || raw} (delete): ${why}`);
        continue;
      }
      if (seen.has(to.toLowerCase())) return no(`${to} is both written and deleted.`);
      seen.add(to.toLowerCase());
      try {
        if (!statSync(path.join(linkDir, to)).isFile()) return no(`${to} is a folder: only files can be deleted, one by one.`);
      } catch {
        continue; // not there: nothing to delete
      }
      deletes.push(to);
    }
    if (refused.length && !files.length && !deletes.length) {
      rmSync(staging, { recursive: true, force: true });
      return no(`Refused, nothing proposed. These paths are never written in a linked folder:\n${refused.map((r) => `- ${r}`).join("\n")}\nDon't look for another way to change them; tell the owner what you wanted there.`);
    }
    if (!files.length && !deletes.length) {
      rmSync(staging, { recursive: true, force: true });
      return { ok: true, text: "Nothing to do: the folder already has exactly these contents." };
    }
    const set: ChangeSet = {
      id,
      link: link.name,
      summary: p.summary.replace(/\s+/g, " ").trim().slice(0, 300) || "Changes from BitBull",
      sessionId: p.sessionId,
      sessionTitle: p.sessionTitle,
      files,
      deletes,
      repo: repoOf(linkDir, [...files.map((f) => f.path), ...deletes]),
      branch: `bitbull/${slug(p.summary)}-${id.slice(0, 4)}`,
      hostStaging: hostPath(staging),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    sets.push(set);
    if (sets.length > KEEP) for (const old of sets.splice(0, sets.length - KEEP)) rmSync(stagingOf(old.id), { recursive: true, force: true });
    record({
      level: "warn",
      source: "integration",
      message: `Changes proposed to the linked folder ${link.name}: ${files.length} file(s)${deletes.length ? `, ${deletes.length} to delete` : ""}. Waiting for you.`,
      detail: [...files.map((f) => `${f.status === "new" ? "new" : "changed"}  ${f.path}`), ...deletes.map((d) => `delete   ${d}`), ...refused.map((r) => `refused  ${r}`)].join("\n"),
      sessionId: p.sessionId,
      sessionTitle: p.sessionTitle,
    });
    changed();
    return {
      ok: true,
      set,
      text: refused.length ? `Left out, because these are never written in a linked folder:\n${refused.map((r) => `- ${r}`).join("\n")}` : "",
    };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return no(`Couldn't stage the changes: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Resolves when the owner answers, or after a few minutes with the proposal still pending. */
export function waitForDecision(id: string, ms = WAIT_MS): Promise<ChangeSet | undefined> {
  const s = sets.find((x) => x.id === id);
  if (!s || s.status !== "pending") return Promise.resolve(s);
  return new Promise((resolve) => {
    const done = (v: ChangeSet) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      waiters.set(id, (waiters.get(id) ?? []).filter((w) => w !== done));
      resolve(s);
    }, ms);
    waiters.set(id, [...(waiters.get(id) ?? []), done]);
  });
}

/** What the owner's browser reports after the helper ran (or the owner declined). */
export function decide(id: string, status: Exclude<ChangeStatus, "pending" | "expired">, message?: string): ChangeSet | null {
  const s = sets.find((x) => x.id === id);
  if (!s) return null;
  if (s.status !== "pending" && !(s.status === "failed" && status !== "failed")) return s;
  s.status = status;
  s.message = message?.replace(/\s+/g, " ").slice(0, 400);
  s.decidedAt = new Date().toISOString();
  // a failed apply can be tried again; anything else is finished with
  if (status !== "failed") rmSync(stagingOf(id), { recursive: true, force: true });
  const what = { applied: "applied to", branch: `put on the branch ${s.branch} in`, declined: "declined for", failed: "could not be applied to" }[status];
  record({ level: status === "failed" ? "error" : "info", source: "integration", message: `Changes ${what} the linked folder ${s.link}${s.message ? `: ${s.message}` : ""}`, sessionId: s.sessionId, sessionTitle: s.sessionTitle });
  for (const w of waiters.get(id) ?? []) w(s);
  waiters.delete(id);
  changed();
  return s;
}

const brief = (s: ChangeSet) => ({ ...s, files: s.files.map(({ diff: _diff, ...f }) => f) });
/** For the card and Settings: newest first, without the diffs. */
export const listChanges = () => [...sets].reverse().map(brief);
export const getChange = (id: string) => sets.find((s) => s.id === id);

/** What the agent is told about a proposal's outcome. */
export function outcomeText(s: ChangeSet | undefined, extra = ""): string {
  if (!s) return "That proposal no longer exists (BitBull restarted). Propose it again if it is still wanted.";
  const tail = extra ? `\n\n${extra}` : "";
  switch (s.status) {
    case "applied":
      return `Applied: the owner approved and the files are now in the linked folder ${s.link}.${tail}`;
    case "branch":
      return `The owner put the change on a new branch, ${s.branch}, in their repo instead of changing their working files. Their files are as before; the change is theirs to review and merge. Don't propose the same change again.${tail}`;
    case "declined":
      return `Declined: the owner chose not to apply this. Nothing was changed. Ask what they would like instead; don't propose the same change again.${tail}`;
    case "failed":
      return `The owner approved, but it could not be applied: ${s.message ?? "no reason given"}. Tell them; they can try again from the card.${tail}`;
    default:
      return `Proposed and waiting: the owner hasn't answered yet (the card stays in their chat until they do, or until BitBull restarts). Nothing has changed in the folder. Carry on with what doesn't depend on it, and say it is waiting.${tail}`;
  }
}

/** test hook */
export function _resetFolderChanges() {
  sets.length = 0;
  waiters.clear();
}
