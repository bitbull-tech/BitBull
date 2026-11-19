/**
 * Integrations are per project: GitHub and 404 too, which used to be on everywhere.
 *
 *   GitHub  The token reaches the agent's shell only in projects that tick GitHub. The Claude
 *           engine's run simply doesn't get it (agent.ts → RunInput.withholdEnv). OpenCode is one
 *           process for every chat, so its guard plugin blanks GITHUB_TOKEN / GH_TOKEN in a shell
 *           whose folder isn't a workspace listed in the file written here.
 *   404     Its skill is mirrored only into the workspaces of projects that tick it (skills.ts).
 *
 * Chats outside a project have neither.
 *
 * This is about what the agent is given, not a wall: the agent shares the server's uid (threat
 * model R1) and the list lives in the data folder, which its shell can write. It keeps a token
 * out of the way of projects that have no business with it; a fine-grained token scoped to the
 * repos you mean is still what limits what it can do.
 *
 * Projects that existed before this change keep both, once: nothing that worked stops working.
 */
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { db, projects, workspaceFor } from "./db.js";

export const GATES_FILE = path.join(config.dataDir, "agent-gates.json");
// the guard plugin runs inside OpenCode, which inherits this (it is a path, not a secret)
process.env.BITBULL_GATES_FILE = GATES_FILE;

/** Environment a project's agent isn't given. */
export const GITHUB_ENV = ["GITHUB_TOKEN", "GH_TOKEN"];
export const FOUR04_SKILL = "404-game-recipe";

export const hasIntegration = (projectId: string | null | undefined, id: string) => {
  const p = projectId ? projects.get(projectId) : null;
  return !!p && projects.integrations(p).includes(id);
};

/** What to keep out of this chat's environment (Claude engine). */
export const withheldEnv = (projectId: string | null | undefined): string[] => (hasIntegration(projectId, "github") ? [] : GITHUB_ENV);

/** Skills a workspace doesn't get. `projectId` null = the general workspace. */
export const withheldSkills = (projectId: string | null | undefined): string[] => (hasIntegration(projectId, "four04") ? [] : [FOUR04_SKILL]);

const real = (dir: string) => {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
};

/** Rewrite the list the guard plugin reads: the workspaces where the agent's shell gets GitHub. */
export function writeGates(): string[] {
  const github = projects
    .list()
    .filter((p) => projects.integrations(p).includes("github"))
    // as BitBull names the folder and as the disk resolves it: the shell's folder may be given either way
    .flatMap((p) => [...new Set([path.resolve(workspaceFor(p)), real(workspaceFor(p))])]);
  try {
    mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${GATES_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ github }), { mode: 0o600 });
    renameSync(tmp, GATES_FILE);
  } catch (e) {
    console.warn(`[gates] couldn't write ${GATES_FILE}: ${e instanceof Error ? e.message : e}`);
  }
  return github;
}

/**
 * Once: projects made while GitHub and 404 were on everywhere keep them. Returns how many
 * projects were touched (0 on every later start).
 */
export function migrateGates(): number {
  const KEY = "gates_migrated";
  const done = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value?: string } | undefined;
  if (done?.value) return 0;
  let n = 0;
  for (const p of projects.list()) {
    const cur = projects.integrations(p);
    const next = [...new Set([...cur, "github", "four04"])];
    if (next.length !== cur.length) {
      projects.update(p.id, { integrations: next });
      n++;
    }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, String(Date.now()));
  return n;
}
