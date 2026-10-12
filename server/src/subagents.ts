import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Subagents: specialists the main agent can start (several at once) to review, challenge,
 * debug, test or take a subtask — the equivalent of Claude Code's Task tool.
 * Defined once in /subagents/*.md; each engine registers them in its own format.
 */
export interface Subagent {
  name: string;
  description: string;
  /** read = no file edits and only inspection/test shell commands; write = full tools */
  access: "read" | "write";
  /** "inherit" or a SayGM model id */
  model: string;
  prompt: string;
}

/** Minimal front-matter parser: `key: value` lines between --- fences. */
export function parseSubagent(md: string) {
  const text = md.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    // strip one pair of matching quotes only
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    fm[line.slice(0, i).trim()] = v;
  }
  return { fm, body: m[2].trim() };
}

const warned = new Set<string>();
const warnOnce = (msg: string) => {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[subagents] ${msg}`);
};

let cache: { at: number; dir: string; list: Subagent[] } | null = null;

/**
 * Load definitions. Never throws: an unreadable or malformed file is skipped with a warning,
 * so one bad file can't take the server or a chat turn down.
 */
export function listSubagents(dir = config.subagentsDir): Subagent[] {
  if (cache && cache.dir === dir && Date.now() - cache.at < 5000) return cache.list.map((a) => ({ ...a }));
  const list: Subagent[] = [];
  let files: string[] = [];
  try {
    if (existsSync(dir)) files = readdirSync(dir).filter((f) => /\.md$/i.test(f) && f.toLowerCase() !== "readme.md").sort();
  } catch (e) {
    warnOnce(`can't read ${dir}: ${e instanceof Error ? e.message : e}`);
  }
  for (const f of files) {
    let md: string;
    try {
      const p = path.join(dir, f);
      if (!statSync(p).isFile()) continue;
      md = readFileSync(p, "utf8");
    } catch (e) {
      warnOnce(`skipping ${f}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const parsed = parseSubagent(md);
    if (!parsed?.fm.name || !parsed.fm.description) {
      warnOnce(`skipping ${f}: needs front matter with name and description`);
      continue;
    }
    const name = parsed.fm.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (list.some((a) => a.name === name)) {
      warnOnce(`skipping ${f}: another file already defines "${name}"`);
      continue;
    }
    const envKey = `SUBAGENT_MODEL_${name.toUpperCase().replace(/-/g, "_")}`;
    const fmModel = parsed.fm.model && parsed.fm.model !== "inherit" ? parsed.fm.model : "";
    const model = process.env[envKey] || fmModel || config.agent.subagentModel || "inherit";
    list.push({
      name,
      description: parsed.fm.description,
      access: parsed.fm.access === "write" ? "write" : "read",
      model,
      prompt: parsed.body,
    });
  }
  cache = { at: Date.now(), dir, list };
  return list.map((a) => ({ ...a }));
}

/** Changes whenever a definition changes; engines that bake agents into config reload on it. */
export function subagentsSignature(list = listSubagents()) {
  return createHash("sha1").update(JSON.stringify(list)).digest("hex").slice(0, 12);
}

/** Warn (once) when a configured subagent model isn't on SayGM, since it silently falls back. */
export function checkSubagentModels(known: Set<string>, list = listSubagents()) {
  for (const a of list) {
    if (a.model !== "inherit" && !known.has(a.model)) warnOnce(`${a.name}: model "${a.model}" isn't on SayGM; using the chat's model instead`);
  }
}

/**
 * Shell rules for read-access subagents (OpenCode bash permission patterns; last match wins).
 * Everything is denied except inspection and test commands, so a reviewer running in parallel
 * with a worker can look and run tests but not rewrite, move, delete, checkout or install.
 */
export const READ_ONLY_BASH: Record<string, "allow" | "deny"> = {
  "*": "deny",
  ...Object.fromEntries(
    [
      "git status*", "git diff*", "git log*", "git show*", "git blame*", "git ls-files*", "git grep*", "git branch", "git branch -a*", "git branch --list*", "git rev-parse*",
      "ls*", "pwd", "cat *", "head *", "tail *", "wc *", "grep *", "rg *", "find *", "tree*", "stat *", "file *", "which *", "du *", "diff *",
      "npm test*", "npm run test*", "npm run typecheck*", "npm run lint*", "npx tsc --noEmit*", "node --test*",
      "pytest*", "python -m pytest*", "python3 -m pytest*", "go test*", "go vet*", "cargo test*", "cargo check*",
    ].map((p) => [p, "allow" as const]),
  ),
  // allowed prefixes that can still write or run arbitrary programs
  "find * -delete*": "deny",
  "find * -exec*": "deny",
  "find * -execdir*": "deny",
  "find * -fprint*": "deny",
  "* > *": "deny",
  "* >> *": "deny",
  "* | tee*": "deny",
};

/** Guidance appended to the system prompt so the main agent actually delegates. */
export function subagentGuide(engine: "opencode" | "claude", list = listSubagents()) {
  if (!list.length) return "";
  const has = (n: string) => list.some((a) => a.name === n);
  const tool = engine === "opencode" ? "`task` tool (subagent_type = the agent name)" : "Task/Agent tool (subagent_type = the agent name)";
  const habits = [
    has("reviewer") && `after a non-trivial code change, run \`reviewer\`${has("tester") ? " (and `tester` when tests are missing)" : ""} before saying you are done`,
    has("challenger") && "before committing to a significant plan, ask `challenger`",
    has("fact-checker") && "for heritage content, run `fact-checker` before generating media",
  ].filter(Boolean);
  return [
    "\n## Subagents",
    "",
    `You can delegate to specialist subagents with the ${tool}. Each runs in its own context and returns a report; you see only the report, so give each a complete, self-contained brief (goal, relevant files, how to verify, what to return).`,
    "Start independent subagents in parallel by issuing several task calls in the same response. Never give two write-access agents the same files. Read-only agents can inspect and run tests but cannot change files.",
    "",
    ...list.map((a) => `- **${a.name}** (${a.access === "write" ? "can edit" : "read-only"}): ${a.description}`),
    ...(habits.length ? ["", `Default habits: ${habits.join("; ")}. Act on their findings or explain why not.`] : []),
  ].join("\n");
}
