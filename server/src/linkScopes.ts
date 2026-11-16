/**
 * Which project a linked folder belongs to. A folder is linked for the project it was linked
 * from; only that project's chats are offered it, can attach it, or can propose changes to it.
 * It can be added to more projects. "general" stands for chats outside any project.
 *
 * This is about what BitBull offers and accepts, not a wall inside the sandbox: every linked
 * folder is mounted at /links for the whole container, so an agent told the path could still read
 * another project's folder. It keeps folders out of the way of projects they have nothing to do
 * with; it is not what protects a folder's contents (the read-only mount and the secrets filter are).
 */
import { db } from "./db.js";

const KEY = "link_projects";
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const projectKey = (id?: string | null) => id || "general";

function load(): Record<string, string[]> {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value?: string } | undefined;
    const j = row?.value ? (JSON.parse(row.value) as Record<string, unknown>) : {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(j ?? {})) if (NAME.test(k) && Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string" && x.length <= 80).slice(0, 50);
    return out;
  } catch {
    return {};
  }
}
function save(all: Record<string, string[]>) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(all));
}

/** The projects a linked folder is in (empty: linked before projects had folders, or not added to one yet). */
export const projectsOf = (name: string): string[] => load()[name] ?? [];
export const allScopes = () => load();
export const inProject = (name: string, project?: string | null) => projectsOf(name).includes(projectKey(project));

export function setScope(name: string, project: string | null | undefined, on: boolean): string[] {
  if (!NAME.test(name)) return [];
  const all = load();
  const key = projectKey(project);
  const cur = new Set(all[name] ?? []);
  if (on) cur.add(key);
  else cur.delete(key);
  all[name] = [...cur];
  save(all);
  return all[name];
}

/** Forget folders that are no longer linked, so a name used again starts in no project. */
export function pruneScopes(linked: string[]) {
  const all = load();
  let changed = false;
  for (const k of Object.keys(all))
    if (!linked.includes(k)) {
      delete all[k];
      changed = true;
    }
  if (changed) save(all);
}
