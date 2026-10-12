import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  /** read = no file edits; write = may edit files in the workspace */
  access: "read" | "write";
  /** "inherit" or a SayGM model id */
  model: string;
  prompt: string;
}

function parse(md: string) {
  const m = md.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body: m[2].trim() };
}

let cache: { at: number; list: Subagent[] } | null = null;

export function listSubagents(): Subagent[] {
  if (cache && Date.now() - cache.at < 5000) return cache.list;
  const dir = config.subagentsDir;
  const list: Subagent[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")) {
      const p = parse(readFileSync(path.join(dir, f), "utf8"));
      if (!p?.fm.name || !p.fm.description) continue;
      const name = p.fm.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const envKey = `SUBAGENT_MODEL_${name.toUpperCase().replace(/-/g, "_")}`;
      const model = process.env[envKey] || (p.fm.model && p.fm.model !== "inherit" ? p.fm.model : config.agent.subagentModel) || "inherit";
      list.push({
        name,
        description: p.fm.description,
        access: p.fm.access === "write" ? "write" : "read",
        model,
        prompt: p.body,
      });
    }
  }
  cache = { at: Date.now(), list };
  return list;
}

/** Guidance appended to the system prompt so the main agent actually delegates. */
export function subagentGuide(engine: "opencode" | "claude") {
  const list = listSubagents();
  if (!list.length) return "";
  const tool = engine === "opencode" ? "`task` tool (subagent_type = the agent name)" : "Task/Agent tool (subagent_type = the agent name)";
  return [
    "\n## Subagents",
    "",
    `You can delegate to specialist subagents with the ${tool}. Each runs in its own context and returns a report; you see only the report, so give each a complete, self-contained brief (goal, relevant files, how to verify, what to return).`,
    "Start independent subagents in parallel by issuing several task calls in the same response. Never give two write-access agents the same files.",
    "",
    ...list.map((a) => `- **${a.name}** (${a.access === "write" ? "can edit" : "read-only"}): ${a.description}`),
    "",
    "Default habits: after a non-trivial code change, run `reviewer` (and `tester` when tests are missing) before saying you are done; before committing to a significant plan, ask `challenger`; for heritage content, run `fact-checker` before generating media. Act on their findings or explain why not.",
  ].join("\n");
}
