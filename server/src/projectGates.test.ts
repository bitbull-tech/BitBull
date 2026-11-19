/** GitHub and 404 per project: what the agent is given follows the project's ticks. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-gates-"));
process.env.APP_TOKEN = "test-token";

const { ROOT } = await import("./config.js");
const { projects, workspaceFor, db } = await import("./db.js");
const G = await import("./projectGates.js");
const { integrations } = await import("./integrations.js");
const { mirrorSkillsInto } = await import("./skills.js");
const { BitBullGuard } = (await import(pathToFileURL(path.join(ROOT, "agent", "opencode-plugin", "bitbull-guard.js")).href)) as {
  BitBullGuard: () => Promise<{ "shell.env": (i: { cwd?: string }, o: { env: Record<string, string> }) => Promise<void> }>;
};

test("no integration is on for every project any more", () => {
  assert.deepEqual(integrations().filter((i) => (i as { global?: boolean }).global).map((i) => i.id), []);
  assert.deepEqual(projects.integrations(projects.create({ name: "fresh" })), []);
});

test("a project without GitHub ticked: the token is kept from its agent, on both engines", async () => {
  const on = projects.create({ name: "with github", integrations: ["github"] });
  const off = projects.create({ name: "without" });
  assert.deepEqual(G.withheldEnv(on.id), []);
  assert.deepEqual(G.withheldEnv(off.id), ["GITHUB_TOKEN", "GH_TOKEN"]);
  assert.deepEqual(G.withheldEnv(null), ["GITHUB_TOKEN", "GH_TOKEN"]); // a chat outside a project

  const listed = G.writeGates();
  assert.ok(listed.includes(path.resolve(workspaceFor(on))));
  assert.ok(!listed.includes(path.resolve(workspaceFor(off))));
  assert.equal((JSON.parse(readFileSync(G.GATES_FILE, "utf8")) as { github: string[] }).github.length, listed.length);

  // OpenCode's shells, through the guard plugin
  const hooks = await BitBullGuard();
  const envFor = async (cwd?: string) => {
    const out = { env: { GITHUB_TOKEN: "t", GH_TOKEN: "t", PATH: "/bin" } as Record<string, string> };
    await hooks["shell.env"]({ cwd }, out);
    return out.env;
  };
  const inside = path.join(workspaceFor(on), "repo", "src");
  mkdirSync(inside, { recursive: true });
  assert.equal((await envFor(workspaceFor(on))).GITHUB_TOKEN, "t");
  assert.equal((await envFor(inside)).GH_TOKEN, "t");
  assert.equal((await envFor(workspaceFor(off))).GITHUB_TOKEN, "");
  assert.equal((await envFor(workspaceFor(off))).GH_TOKEN, "");
  assert.equal((await envFor(`${workspaceFor(on)}-evil`)).GITHUB_TOKEN, ""); // a folder that only starts the same
  assert.equal((await envFor(undefined)).GITHUB_TOKEN, "");
  assert.equal((await envFor(workspaceFor(off))).PATH, "/bin");

  // unticking takes it away again
  projects.update(on.id, { integrations: [] });
  G.writeGates();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await envFor(workspaceFor(on))).GITHUB_TOKEN, "");

  // a list that can't be read: blanked. No list named at all (an older server): as before.
  writeFileSync(G.GATES_FILE, "not json");
  assert.equal((await envFor(workspaceFor(on))).GITHUB_TOKEN, "");
  const file = process.env.BITBULL_GATES_FILE;
  delete process.env.BITBULL_GATES_FILE;
  assert.equal((await envFor(workspaceFor(off))).GITHUB_TOKEN, "t");
  process.env.BITBULL_GATES_FILE = file;
});

test("the 404 skill is only in the workspaces of projects that tick it", () => {
  const on = projects.create({ name: "with 404", integrations: ["four04"] });
  const off = projects.create({ name: "no 404" });
  const skill = (p: { id: string }) => path.join(workspaceFor(projects.get(p.id)!), ".claude", "skills", G.FOUR04_SKILL);
  mirrorSkillsInto(workspaceFor(on), G.withheldSkills(on.id));
  mirrorSkillsInto(workspaceFor(off), G.withheldSkills(off.id));
  assert.equal(existsSync(skill(on)), true);
  assert.equal(existsSync(skill(off)), false);
  assert.equal(existsSync(path.join(workspaceFor(off), ".claude", "skills", "code-review")), true);
  // unticked later: the copy BitBull put there is taken out
  projects.update(on.id, { integrations: [] });
  mirrorSkillsInto(workspaceFor(on), G.withheldSkills(on.id));
  assert.equal(existsSync(skill(on)), false);
});

test("projects from before keep GitHub and 404, once", () => {
  db.prepare("DELETE FROM meta WHERE key = 'gates_migrated'").run();
  const old = projects.create({ name: "old project", integrations: ["atlas"] });
  assert.ok(G.migrateGates() >= 1);
  assert.deepEqual(projects.integrations(projects.get(old.id)!).sort(), ["atlas", "four04", "github"]);
  const later = projects.create({ name: "made afterwards" });
  assert.equal(G.migrateGates(), 0);
  assert.deepEqual(projects.integrations(projects.get(later.id)!), []);
});
