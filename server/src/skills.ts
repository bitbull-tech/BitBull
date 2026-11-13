import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config, paths, ROOT } from "./config.js";
import { projects, workspaceFor } from "./db.js";
import { backupSkill, dittoEnabled } from "./ditto.js";

/**
 * Skills live in the repo (/skills/<name>/SKILL.md) so they're versioned in Git.
 * On boot they're mirrored into <workspace>/.claude/skills, which BOTH engines read
 * (Claude Agent SDK via settingSources:["project"], OpenCode natively), and backed
 * up to Ditto so they're also part of long-term memory.
 */
export interface SkillInfo {
  dir: string;
  name: string;
  description: string;
  hash: string;
}

function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function listSkills(): SkillInfo[] {
  if (!existsSync(config.skillsDir)) return [];
  return readdirSync(config.skillsDir, { withFileTypes: true })
    .filter((d) => {
      // a folder (or anything else) named SKILL.md must not break startup
      try {
        return d.isDirectory() && statSync(path.join(config.skillsDir, d.name, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    })
    .map((d) => {
      const md = readFileSync(path.join(config.skillsDir, d.name, "SKILL.md"), "utf8");
      const fm = parseFrontmatter(md);
      return {
        dir: d.name,
        name: fm.name ?? d.name,
        description: fm.description ?? "",
        hash: createHash("sha256").update(md).digest("hex").slice(0, 12),
      };
    });
}

/** Which skills in a workspace BitBull put there (so skills you add yourself are left alone). */
const MANIFEST = ".bitbull-skills.json";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Remove a file or folder, retrying when the filesystem says "not empty" or "busy": on a shared
 * folder (a Mac's VM mount, a Windows bind mount) a delete can lag behind, and an engine may
 * still be reading a skill. Never follows a symlink: the link itself is removed.
 */
const remove = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });

/**
 * A real folder at `dir`, whatever was there. The workspace belongs to the agent, which could
 * have left a symlink (or a file) where `.claude` or `.claude/skills` should be; writing through
 * it would put BitBull's files, and its deletes, somewhere else.
 */
function realDir(dir: string) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    mkdirSync(dir, { recursive: true });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    remove(dir);
    mkdirSync(dir, { recursive: true });
  }
}

function managedBefore(target: string): string[] {
  try {
    const list = JSON.parse(readFileSync(path.join(target, MANIFEST), "utf8")) as unknown;
    if (Array.isArray(list)) return list.filter((n): n is string => typeof n === "string" && SAFE_NAME.test(n));
  } catch {
    /* no list yet: an older BitBull, which owned everything in the folder */
  }
  try {
    return readdirSync(target, { withFileTypes: true }).filter((d) => d.isDirectory() && SAFE_NAME.test(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Copy the repo's skills into one workspace's .claude/skills (read by both engines).
 *
 * Each skill is replaced on its own: copied next to the old one, then swapped in, so a skill is
 * never half there and one that can't be replaced right now keeps its previous copy. Only skills
 * BitBull put there are touched; one the repo no longer has is removed; anything else in the
 * folder (a skill you or the agent added) stays. A skill the agent edited is put back as the repo
 * has it: the repo is the source of truth, here and at every start.
 *
 * Returns the skills that could not be refreshed (their old copy is still in place).
 */
export function mirrorSkillsInto(workspace: string): string[] {
  mkdirSync(workspace, { recursive: true });
  const claude = path.join(workspace, ".claude");
  const target = path.join(claude, "skills");
  realDir(claude);
  realDir(target);
  const root = realpathSync(workspace);
  const real = realpathSync(target);
  if (real !== path.join(root, ".claude", "skills")) throw new Error(`${target} is not inside its workspace`);

  const wanted = existsSync(config.skillsDir) ? listSkills().map((s) => s.dir).filter((n) => SAFE_NAME.test(n)) : [];
  const failed: string[] = [];
  // leftovers of an interrupted copy
  for (const d of readdirSync(target)) if (/^\.[^/]+\.new$/.test(d)) remove(path.join(target, d));
  for (const name of managedBefore(target)) {
    if (wanted.includes(name)) continue;
    try {
      remove(path.join(target, name));
    } catch {
      failed.push(name);
    }
  }
  for (const name of wanted) {
    const dest = path.join(target, name);
    const fresh = path.join(target, `.${name}.new`);
    try {
      remove(fresh);
      cpSync(path.join(config.skillsDir, name), fresh, { recursive: true });
      remove(dest);
      renameSync(fresh, dest);
    } catch (e) {
      failed.push(name);
      try {
        remove(fresh);
      } catch {
        /* cleared on the next sync */
      }
      console.warn(`[skills] couldn't refresh "${name}" in ${workspace} (its previous copy stays): ${e instanceof Error ? e.message : e}`);
    }
  }
  writeFileSync(path.join(target, MANIFEST), JSON.stringify(wanted.filter((n) => !failed.includes(n) || existsSync(path.join(target, n)))));
  return failed;
}

// Helper scripts the skills call (e.g. tools/atlas-run.mjs) are reachable via $BITBULL_TOOLS
process.env.BITBULL_TOOLS = path.join(ROOT, "tools");
process.env.ATLAS_WORKFLOWS_DIR = config.integrations.atlas.workflowsDir;

export async function syncSkills({ backup = true } = {}) {
  const spaces = [paths.workspace, ...projects.list().map((p) => workspaceFor(p))];
  // one workspace that can't be refreshed must not stop the others, or the server from starting
  let behind = 0;
  for (const w of spaces) {
    try {
      if (mirrorSkillsInto(w).length) behind++;
    } catch (e) {
      behind++;
      console.warn(`[skills] couldn't refresh the skills in ${w}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const skills = listSkills();
  console.log(`[skills] ${skills.length} skill(s) mirrored to ${spaces.length - behind} of ${spaces.length} workspace(s)${behind ? "; the rest keep their previous copies until the next start or Sync" : ""}`);
  if (backup && dittoEnabled()) {
    // In the background: startup and the UI never wait on Ditto (it retries when the network blips)
    void (async () => {
      for (const s of skills) {
        await backupSkill(s.name, readFileSync(path.join(config.skillsDir, s.dir, "SKILL.md"), "utf8"), s.hash);
      }
    })().catch((e) => console.error("[skills] backup to Ditto failed:", e instanceof Error ? e.message : e));
  }
  return skills;
}
