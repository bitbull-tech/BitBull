import { readFileSync, existsSync } from "node:fs";
import { config, shellAllowed, type EngineId } from "./config.js";
import { messages, projects, sessions, workspaceFor, type ProjectRow, type SessionRow } from "./db.js";
import { archiveTurn } from "./ditto.js";
import { claudeEngine } from "./engines/claude.js";
import { opencodeEngine } from "./engines/opencode.js";
import type { AgentEngine, AgentEvent, Usage } from "./engines/types.js";
import { mcpServersFor, type IntegrationId } from "./integrations.js";
import { estimateCost } from "./models.js";
import { subagentGuide } from "./subagents.js";
import { setRunningSessions } from "./mcp.js";
import { record, redact } from "./activity.js";

export const engines: Record<EngineId, AgentEngine> = {
  opencode: opencodeEngine,
  claude: claudeEngine,
};

const running = new Map<string, AbortController>();
setRunningSessions(() => [...running.keys()]);

const LIKENESS_RULES: Record<string, string> = {
  "ground-only":
    "Likeness policy (ground-only): real, named people from uploads may only be shown through their original images (Ken Burns, parallax, restoration of the scan itself). Use generative image/video/3D for places, aircraft, ships, weather, crowds and period atmosphere: reconstruct the ground, never the person. Never synthesise the voice of a named individual.",
  "private-likeness":
    "Likeness policy (private-likeness): generative animation of a real person's photo is allowed only inside this private project, only from images the user uploaded and confirms they have rights to, and every output must be labelled as AI-generated. Never synthesise the voice of a named individual. Never invent facts about a named person: anything stated about them must come from an attached source.",
};

function systemPrompt(project: ProjectRow | null | undefined, engine: EngineId) {
  const parts = [existsSync(config.promptFile) ? readFileSync(config.promptFile, "utf8") : ""];
  parts.push(
    shellAllowed()
      ? `\n## Environment\n\nYou run inside an isolated ${config.sandbox.kind} sandbox. Your shell and files are confined to it; the user's computer is not reachable.${config.sandbox.egressProxy ? " Internet access goes through an allowlist proxy. If a site or package host is refused (HTTP 403 from the proxy, 'CONNECT tunnel failed', 'Forbidden'), call the request_network_access tool (GM's own tool, named gm_request_network_access or mcp__gm__request_network_access) with the host and a one-sentence reason; it waits for the user's answer, then retry. Ask only for domains the task needs, and never try to get round the proxy." : ""}`
      : `\n## Environment\n\nShell commands are disabled in this environment (not sandboxed). Use file tools only, and tell the user if a task needs a shell.`,
  );
  parts.push(subagentGuide(engine));
  parts.push(`\n## Heritage media\n\n${LIKENESS_RULES[config.heritage.likenessPolicy] ?? LIKENESS_RULES["ground-only"]}`);
  if (project) {
    parts.push(
      `\n## Project: ${project.name}\n\nYour working directory is this project's workspace; keep all files for it there.` +
        (project.description ? `\n\nAbout this project: ${project.description}` : "") +
        (project.instructions ? `\n\nProject instructions (follow these):\n${project.instructions}` : "") +
        `\n\nWhen saving memories about this project, include "Project: ${project.name}" in the memory text.`,
    );
  }
  return parts.join("\n");
}

/**
 * When the engine has no session to resume (first turn after moving a chat between
 * projects, or after an engine reset), replay the conversation so far as context.
 */
function recap(sessionId: string, maxChars = 24000) {
  const hist = messages.list(sessionId);
  if (!hist.length) return "";
  const lines: string[] = [];
  let used = 0;
  for (const m of [...hist].reverse()) {
    const line = `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return `Conversation so far (restored from history):\n\n${lines.join("\n\n")}\n\n---\n\n`;
}

function titleFrom(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 57) + "…" : t || "New chat";
}

export function abortRun(sessionId: string) {
  running.get(sessionId)?.abort();
}

export function isRunning(sessionId: string) {
  return running.has(sessionId);
}

/**
 * Run one turn on a session. Yields engine-neutral events, persists history
 * locally and archives the turn to Ditto when finished.
 */
export async function* runTurn(
  session: SessionRow,
  prompt: string,
  model: string,
  attachments: string[] = [],
  opts: { plan?: boolean } = {},
): AsyncGenerator<AgentEvent & { messageId?: string }> {
  if (running.has(session.id)) {
    yield { type: "error", message: "This session is already running a turn." };
    return;
  }
  const engine = engines[session.engine];
  const ctrl = new AbortController();
  running.set(session.id, ctrl);

  const project = projects.get(session.project_id);
  const cwd = workspaceFor(project);
  const mcp = mcpServersFor(projects.integrations(project) as IntegrationId[]);
  // No engine session to resume but history exists → give the model the transcript
  const restore = !session.engine_session_id ? recap(session.id) : "";
  const isFirst = messages.list(session.id).length === 0;
  // Attachments live in the workspace; tell the agent where, and keep a record in history.
  const files = attachments.filter((a) => /^uploads\/[^\0\n]+$/.test(a) && !a.split("/").includes(".."));
  const attachNote = files.length
    ? `\n\nAttached files (in your workspace, read them with your tools):\n${files.map((f) => `- ${f}`).join("\n")}`
    : "";
  messages.add({
    session_id: session.id,
    role: "user",
    content: prompt,
    model,
    tools_json: files.length ? JSON.stringify({ attachments: files }) : null,
    usage_json: null,
  });
  if (isFirst) sessions.update(session.id, { title: titleFrom(prompt) });
  if (model !== session.model) sessions.update(session.id, { model });

  const title = sessions.get(session.id)?.title ?? session.title;
  const act = (e: Parameters<typeof record>[0]) => record({ sessionId: session.id, sessionTitle: title, ...e });
  const short = (v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return s.length > 160 ? s.slice(0, 157) + "…" : s;
  };
  act({
    level: "info",
    source: "agent",
    message: `Turn started · ${model} · ${session.engine}${opts.plan ? " · plan mode" : ""}${project ? ` · ${project.name}` : ""}`,
    detail: prompt + attachNote,
  });
  const started = Date.now();

  let text = "";
  let usage: Usage | undefined;
  let engineSessionId = session.engine_session_id;
  const tools: Array<{ id: string; name: string; input?: unknown; output?: string; isError?: boolean; parent?: string }> = [];

  try {
    for await (const ev of engine.run({
      engineSessionId,
      model,
      prompt: restore + prompt + attachNote,
      systemPrompt: systemPrompt(project, session.engine),
      signal: ctrl.signal,
      cwd,
      mcp,
      gmSessionId: session.id,
      plan: opts.plan,
    })) {
      // Never let a credential reach the UI, the chat history or Ditto, whatever printed it
      if (ev.type === "text" || ev.type === "thinking") ev.delta = redact(ev.delta);
      if (ev.type === "tool_start" && ev.input !== undefined) ev.input = JSON.parse(redact(JSON.stringify(ev.input)));
      if (ev.type === "tool_end" && ev.output) ev.output = redact(ev.output);
      if (ev.type === "error") ev.message = redact(ev.message);
      if (ev.type === "text") text += ev.delta;
      if (ev.type === "tool_start") {
        tools.push({ id: ev.id, name: ev.name, input: ev.input, ...(ev.parent ? { parent: ev.parent } : {}) });
        const isAgent = /^(task|agent)$/i.test(ev.name);
        const inp = (ev.input ?? {}) as Record<string, unknown>;
        act({
          level: "info",
          source: isAgent ? "subagent" : ev.parent ? "subagent" : "tool",
          message: isAgent
            ? `Subagent ${inp.subagent_type ?? ""} started: ${inp.description ?? ""}`
            : `${ev.parent ? "↳ " : ""}${ev.name} ${short(inp.command ?? inp.filePath ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.url ?? inp.query ?? "")}`,
          detail: JSON.stringify(ev.input ?? {}, null, 2),
        });
      }
      if (ev.type === "tool_end") {
        const t = tools.find((x) => x.id === ev.id);
        Object.assign(t ?? {}, { output: ev.output, isError: ev.isError });
        if (ev.isError) act({ level: "warn", source: ev.parent ? "subagent" : "tool", message: `${t?.name ?? "tool"} failed: ${short(ev.output)}`, detail: ev.output });
        else if (t && /^(task|agent)$/i.test(t.name)) act({ level: "info", source: "subagent", message: `Subagent ${(t.input as { subagent_type?: string })?.subagent_type ?? ""} finished`, detail: ev.output });
      }
      if (ev.type === "error") act({ level: "error", source: session.engine, message: ev.message });
      if (ev.type === "done") {
        usage = ev.usage;
        if (ev.engineSessionId) engineSessionId = ev.engineSessionId;
        break;
      }
      yield ev;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    act({ level: "error", source: session.engine, message, detail: err instanceof Error ? err.stack : undefined });
    yield { type: "error", message };
  } finally {
    running.delete(session.id);
  }

  // Engines don't know SayGM's prices; estimate from the live price list.
  if (usage && !usage.costUsd && (usage.inputTokens || usage.outputTokens)) {
    usage = { ...usage, costUsd: await estimateCost(model, usage.inputTokens, usage.outputTokens) };
  }

  if (engineSessionId && engineSessionId !== session.engine_session_id) {
    sessions.update(session.id, { engine_session_id: engineSessionId });
  }
  text = redact(text); // a secret split across two stream chunks is caught here
  const saved = messages.add({
    session_id: session.id,
    role: "assistant",
    content: text,
    model,
    tools_json: tools.length ? JSON.stringify(tools) : null,
    usage_json: usage ? JSON.stringify(usage) : null,
  });
  sessions.update(session.id, {});
  act({
    level: "info",
    source: "agent",
    message: `Turn finished in ${((Date.now() - started) / 1000).toFixed(1)}s · ${tools.length} tool call${tools.length === 1 ? "" : "s"}${
      usage ? ` · ${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out${usage.costUsd ? ` · $${usage.costUsd.toFixed(4)}` : ""}` : ""
    }${ctrl.signal.aborted ? " · stopped by user" : ""}`,
  });

  // Fire-and-forget: long-term memory shouldn't slow the UI down.
  if (text.trim()) {
    const fresh = sessions.get(session.id)!;
    void archiveTurn({
      sessionId: session.id,
      sessionTitle: fresh.title,
      messageId: saved.id,
      engine: session.engine,
      model,
      project: project?.name,
      user: prompt,
      assistant: text,
    });
  }

  yield { type: "done", engineSessionId: engineSessionId ?? "", usage, messageId: saved.id };
}
