import { recent, redact } from "./activity.js";
import { config, shellAllowed } from "./config.js";
import { messages, projects, sessions } from "./db.js";
import { listSkills } from "./skills.js";
import { listSubagents } from "./subagents.js";

/**
 * Export a chat in a form you can paste into another agent (Claude, ChatGPT, Codex…) for a
 * second opinion or debugging: transcript, tool calls, the chat's activity log and a short
 * description of how GM is set up. Secrets are redacted throughout.
 */
type Tool = { id: string; name: string; input?: unknown; output?: string; isError?: boolean; parent?: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more characters cut)` : s);
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const fence = (s: string, lang = "") => {
  // pick a fence longer than any backtick run inside, so nested code blocks survive
  const longest = Math.max(2, ...(s.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${s}\n${f}`;
};

export interface ExportOptions {
  /** include tool calls (inputs and outputs) */
  tools?: boolean;
  /** include this chat's activity log */
  activity?: boolean;
  /** max characters per tool output */
  outputLimit?: number;
}

export function exportJson(sessionId: string) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const p = projects.get(s.project_id);
  return {
    exportedAt: new Date().toISOString(),
    app: "GM Agent",
    session: { id: s.id, title: s.title, engine: s.engine, model: s.model, project: p?.name ?? null, createdAt: iso(s.created_at) },
    environment: environment(p?.name),
    messages: messages.list(sessionId).map((m) => ({
      role: m.role,
      at: iso(m.created_at),
      model: m.model,
      content: redact(m.content),
      ...(m.tools_json ? { tools: JSON.parse(redact(m.tools_json)) } : {}),
      ...(m.usage_json ? { usage: JSON.parse(m.usage_json) } : {}),
    })),
    activity: recent({ sessionId, limit: 2000 }),
  };
}

function environment(project?: string) {
  return {
    sandbox: config.sandbox.kind === "none" ? "none (host; agent shell off)" : `${config.sandbox.kind} container`,
    shell: shellAllowed() ? "on (confined to the sandbox)" : "off",
    internet: config.sandbox.egressProxy ? "allowlist proxy only (egress/allowlist.txt)" : "open",
    engines: "OpenCode (any SayGM model) or Claude Agent SDK",
    modelGateway: "SayGM (api.saygm.com)",
    memory: config.ditto.apiKey ? `Ditto MCP (archive: ${config.ditto.archive})` : "off",
    project: project ?? "(none: general workspace)",
    subagents: listSubagents().map((a) => `${a.name} (${a.access})`).join(", ") || "none",
    skills: listSkills().map((k) => k.name).join(", ") || "none",
    node: process.version,
  };
}

export function exportMarkdown(sessionId: string, opts: ExportOptions = {}) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const p = projects.get(s.project_id);
  const limit = opts.outputLimit ?? 2000;
  const env = environment(p?.name);
  const rows = messages.list(sessionId);
  const out: string[] = [];

  out.push(`# GM Agent chat: ${s.title}`);
  out.push("");
  out.push(
    "> Exported from **GM Agent**, a self-hosted AI agent on the SayGM model gateway. It runs agent engines (OpenCode or the Claude Agent SDK) in a Docker sandbox whose only internet access is an allowlist proxy, with Ditto as long-term memory. Credentials have been replaced with `[REDACTED]`. Below: the setup, the full transcript with tool calls, and the activity log for this chat.",
  );
  out.push("");
  out.push("## Setup");
  out.push("");
  out.push(`- Chat: ${s.id} · started ${iso(s.created_at)} · exported ${new Date().toISOString().slice(0, 19)}Z`);
  out.push(`- Engine: ${s.engine} · model(s): ${[...new Set(rows.map((m) => m.model).filter(Boolean))].join(", ") || s.model}`);
  for (const [k, v] of Object.entries(env)) out.push(`- ${k}: ${v}`);
  out.push("");
  out.push("## Transcript");

  rows.forEach((m, i) => {
    out.push("");
    let usage = "";
    if (m.usage_json) {
      try {
        const u = JSON.parse(m.usage_json) as { inputTokens?: number; outputTokens?: number; costUsd?: number };
        usage = ` · ${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out${u.costUsd ? ` · $${u.costUsd.toFixed(4)}` : ""}`;
      } catch {
        /* ignore */
      }
    }
    out.push(`### ${i + 1}. ${m.role === "user" ? "User" : `Assistant (${m.model ?? s.model})`} · ${iso(m.created_at)}${usage}`);
    out.push("");
    let tools: Tool[] = [];
    let attachments: string[] = [];
    if (m.tools_json) {
      try {
        const parsed = JSON.parse(m.tools_json);
        if (Array.isArray(parsed)) tools = parsed;
        else if (Array.isArray(parsed?.attachments)) attachments = parsed.attachments;
      } catch {
        /* ignore */
      }
    }
    if (opts.tools !== false && tools.length) {
      out.push(`**Tool calls (${tools.length})**`);
      out.push("");
      const top = tools.filter((t) => !t.parent);
      const render = (t: Tool, depth: number) => {
        const pad = "  ".repeat(depth);
        const inp = t.input === undefined ? "" : clip(redact(JSON.stringify(t.input)), 600);
        out.push(`${pad}- \`${t.name}\`${t.isError ? " **(failed)**" : ""}${inp ? ` ${inp.includes("\n") ? "" : `\`${inp.replace(/`/g, "'")}\``}` : ""}`);
        if (inp.includes("\n")) out.push(fence(inp, "json").replace(/^/gm, pad + "  "));
        if (t.output) out.push(fence(clip(redact(t.output), limit)).replace(/^/gm, pad + "  "));
        for (const c of tools.filter((x) => x.parent === t.id)) render(c, depth + 1);
      };
      top.forEach((t) => render(t, 0));
      out.push("");
    }
    if (m.content.trim()) out.push(redact(m.content.trim()));
    else if (m.role === "assistant") out.push("_(no text reply)_");
    if (attachments.length) out.push("", `Attached: ${attachments.map((a) => `\`${a}\``).join(", ")}`);
  });

  if (opts.activity !== false) {
    const acts = recent({ sessionId, limit: 500 });
    out.push("", "## Activity log for this chat", "");
    if (!acts.length) out.push("_(none recorded)_");
    else
      out.push(
        fence(
          acts
            .map((e) => `${e.ts} ${e.level.toUpperCase()} [${e.source}] ${e.message}${e.detail && e.level !== "info" ? `\n  ${clip(e.detail, 800).replace(/\n/g, "\n  ")}` : ""}`)
            .join("\n"),
          "log",
        ),
      );
  }
  out.push("");
  return redact(out.join("\n"));
}
