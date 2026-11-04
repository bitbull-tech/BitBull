import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

/** Copy repo skills into one workspace's .claude/skills (read by both engines). */
export function mirrorSkillsInto(workspace: string) {
  const target = path.join(workspace, ".claude", "skills");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  if (existsSync(config.skillsDir)) cpSync(config.skillsDir, target, { recursive: true });
}

// Helper scripts the skills call (e.g. tools/atlas-run.mjs) are reachable via $BITBOB_TOOLS
process.env.BITBOB_TOOLS = path.join(ROOT, "tools");
process.env.ATLAS_WORKFLOWS_DIR = config.integrations.atlas.workflowsDir;

export async function syncSkills({ backup = true } = {}) {
  const spaces = [paths.workspace, ...projects.list().map((p) => workspaceFor(p))];
  for (const w of spaces) mirrorSkillsInto(w);
  const skills = listSkills();
  console.log(`[skills] ${skills.length} skill(s) mirrored to ${spaces.length} workspace(s)`);
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
