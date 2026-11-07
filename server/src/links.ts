import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Read-only links: folders on the user's computer that the agent may read but never change.
 *
 * They are mounted at /links/<name> by the user, from Windows (scripts/bitbull-wsl/link.ps1):
 * read-only and no-exec in the bitbull distro, and read-only again into this container. BitBull only
 * lists them; nothing here (or in the UI) can add, remove or widen one.
 */
export const LINKS_ROOT = process.env.BITBULL_LINKS_PATH || "/links";

export interface LinkedFolder {
  name: string;
  /** absolute path inside the container */
  path: string;
  /** top-level entries (files + folders), or null if it can't be read */
  entries: number | null;
  /** the mount it lives on is read-only (from /proc/self/mountinfo), as it must be */
  readOnly: boolean;
  /** and nothing on it can be executed */
  noExec: boolean;
}

interface MountEntry {
  point: string;
  opts: string[];
}
const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
function mounts(): MountEntry[] {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        // id parent major:minor root mountpoint opts [optional...] - fstype source superopts
        const [left, right = ""] = line.split(" - ");
        const f = left.split(" ");
        const sup = right.split(" ")[2] ?? "";
        return { point: unescape(f[4]), opts: [...f[5].split(","), ...sup.split(",")] };
      });
  } catch {
    return [];
  }
}
/** Flags of the mount a path lives on: the innermost mount point containing it (last one wins). */
export function mountFlagsOf(p: string, table = mounts()) {
  let best: MountEntry | undefined;
  for (const m of table) {
    const inside = p === m.point || p.startsWith(m.point.endsWith("/") ? m.point : `${m.point}/`);
    if (inside && (!best || m.point.length >= best.point.length)) best = m;
  }
  return { readOnly: !!best?.opts.includes("ro"), noExec: !!best?.opts.includes("noexec"), mountPoint: best?.point ?? null };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function linksAvailable() {
  return existsSync(LINKS_ROOT);
}

export function listLinks(): LinkedFolder[] {
  if (!linksAvailable()) return [];
  let names: string[] = [];
  try {
    names = readdirSync(LINKS_ROOT).filter((n) => NAME.test(n));
  } catch {
    return [];
  }
  const out: LinkedFolder[] = [];
  const table = mounts();
  for (const name of names.sort()) {
    const p = path.join(LINKS_ROOT, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    let entries: number | null = null;
    try {
      entries = readdirSync(p).length;
    } catch {
      /* unreadable */
    }
    // A folder that isn't mounted (link removed, or Windows path gone) is an empty directory
    if (entries === 0) continue;
    const { readOnly, noExec } = mountFlagsOf(p, table);
    out.push({ name, path: p, entries, readOnly, noExec });
  }
  return out;
}

/** "links/<name>" or "/links/<name>" → the linked folder, if it is one. Writable ones are never handed out. */
export function resolveLink(ref: string): LinkedFolder | null {
  const m = /^\/?links\/([a-z0-9][a-z0-9-]{0,39})\/?$/.exec(ref);
  if (!m) return null;
  const l = listLinks().find((x) => x.name === m[1]);
  return l && l.readOnly ? l : null;
}
