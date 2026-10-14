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
  /** only one exchange: the assistant message with this id (plus the user message before it), or "last" */
  exchange?: string;
  /** just prompt + reply (+ errors), no setup, tool calls or log: for a quick second opinion */
  compact?: boolean;
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
  const all = messages.list(sessionId);
  let rows = all;
  let window: [number, number] | null = null;
  if (opts.exchange) {
    // the chosen (or last) assistant reply and the user message that prompted it
    const idx =
      opts.exchange === "last"
        ? all.map((m) => m.role).lastIndexOf("assistant")
        : all.findIndex((m) => m.id === opts.exchange && m.role === "assistant");
    if (idx < 0) return null;
    const start = idx > 0 && all[idx - 1].role === "user" ? idx - 1 : idx;
    rows = all.slice(start, idx + 1);
    window = [rows[0].created_at - 1000, all[idx].created_at + 2000];
  }
  const out: string[] = [];

  if (opts.compact) {
    // Short form: what was asked and what came back, nothing else
    const errs = recent({ sessionId, level: "error", limit: 200 }).filter((e) => !window || (Date.parse(e.ts) >= window[0] && Date.parse(e.ts) <= window[1]));
    for (const m of rows) {
      if (m.role === "user") {
        out.push("**Prompt:**", "", redact(m.content.trim()), "");
        try {
          const a = m.tools_json ? JSON.parse(m.tools_json)?.attachments : null;
          if (Array.isArray(a) && a.length) out.push(`_Attachments: ${a.map((x: string) => x.split("/").pop()).join(", ")}_`, "");
        } catch {
          /* ignore */
        }
      } else {
        out.push(`**Response (${m.model ?? s.model}):**`, "", redact(m.content.trim()) || "_(no text reply)_", "");
      }
    }
    if (errs.length) out.push(`_Errors during this turn: ${errs.map((e) => e.message).join(" · ")}_`, "");
    return redact(out.join("\n"));
  }

  out.push(opts.exchange ? `# GM Agent: one exchange from "${s.title}"` : `# GM Agent chat: ${s.title}`);
  out.push("");
  out.push(
    `> Exported from **GM Agent**, a self-hosted AI agent on the SayGM model gateway. It runs agent engines (OpenCode or the Claude Agent SDK) in a Docker sandbox whose only internet access is an allowlist proxy, with Ditto as long-term memory. Credentials have been replaced with \`[REDACTED]\`. Below: the setup, ${
      opts.exchange ? "one request and the agent's reply" : "the full transcript"
    } with tool calls, and the activity log${opts.exchange ? " for that exchange" : ""}.`,
  );
  out.push("");
  out.push("## Setup");
  out.push("");
  out.push(`- Chat: ${s.id} · started ${iso(s.created_at)} · exported ${new Date().toISOString().slice(0, 19)}Z`);
  out.push(`- Engine: ${s.engine} · model(s): ${[...new Set(rows.map((m) => m.model).filter(Boolean))].join(", ") || s.model}`);
  for (const [k, v] of Object.entries(env)) out.push(`- ${k}: ${v}`);
  out.push("");
  if (opts.exchange && all.length > rows.length) out.push("", `_This is message ${all.indexOf(rows[0]) + 1}–${all.indexOf(rows[rows.length - 1]) + 1} of ${all.length} in the chat; earlier context isn't included._`);
  out.push("");
  out.push(opts.exchange ? "## Exchange" : "## Transcript");

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
    let acts = recent({ sessionId, limit: 500 });
    if (window) {
      // start at this exchange's own "Turn started" so the previous turn's tail isn't included
      const w = window;
      const startEv = acts.filter((e) => e.message.startsWith("Turn started") && Date.parse(e.ts) >= w[0] && Date.parse(e.ts) <= w[1]).at(-1);
      const from = startEv ? Date.parse(startEv.ts) : w[0];
      acts = acts.filter((e) => Date.parse(e.ts) >= from && Date.parse(e.ts) <= w[1]);
    }
    out.push("", opts.exchange ? "## Activity log for this exchange" : "## Activity log for this chat", "");
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
