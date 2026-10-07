import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { config, paths } from "./config.js";
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
    .filter((d) => d.isDirectory() && existsSync(path.join(config.skillsDir, d.name, "SKILL.md")))
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

export async function syncSkills({ backup = true } = {}) {
  const target = path.join(paths.workspace, ".claude", "skills");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  if (existsSync(config.skillsDir)) cpSync(config.skillsDir, target, { recursive: true });
  const skills = listSkills();
  console.log(`[skills] ${skills.length} skill(s) mirrored to workspace`);
  if (backup && dittoEnabled()) {
    for (const s of skills) {
      await backupSkill(s.name, readFileSync(path.join(config.skillsDir, s.dir, "SKILL.md"), "utf8"), s.hash);
    }
  }
  return skills;
}
