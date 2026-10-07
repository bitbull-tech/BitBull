import { readFileSync, existsSync } from "node:fs";
import { config, type EngineId } from "./config.js";
import { messages, sessions, type SessionRow } from "./db.js";
import { archiveTurn } from "./ditto.js";
import { claudeEngine } from "./engines/claude.js";
import { opencodeEngine } from "./engines/opencode.js";
import type { AgentEngine, AgentEvent, Usage } from "./engines/types.js";

export const engines: Record<EngineId, AgentEngine> = {
  opencode: opencodeEngine,
  claude: claudeEngine,
};

const running = new Map<string, AbortController>();

function systemPrompt() {
  return existsSync(config.promptFile) ? readFileSync(config.promptFile, "utf8") : "";
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
): AsyncGenerator<AgentEvent & { messageId?: string }> {
  if (running.has(session.id)) {
    yield { type: "error", message: "This session is already running a turn." };
    return;
  }
  const engine = engines[session.engine];
  const ctrl = new AbortController();
  running.set(session.id, ctrl);

  const isFirst = messages.list(session.id).length === 0;
  messages.add({ session_id: session.id, role: "user", content: prompt, model, tools_json: null, usage_json: null });
  if (isFirst) sessions.update(session.id, { title: titleFrom(prompt) });
  if (model !== session.model) sessions.update(session.id, { model });

  let text = "";
  let usage: Usage | undefined;
  let engineSessionId = session.engine_session_id;
  const tools: Array<{ id: string; name: string; input?: unknown; output?: string; isError?: boolean }> = [];

  try {
    for await (const ev of engine.run({
      engineSessionId,
      model,
      prompt,
      systemPrompt: systemPrompt(),
      signal: ctrl.signal,
    })) {
      if (ev.type === "text") text += ev.delta;
      if (ev.type === "tool_start") tools.push({ id: ev.id, name: ev.name, input: ev.input });
      if (ev.type === "tool_end") Object.assign(tools.find((t) => t.id === ev.id) ?? {}, { output: ev.output, isError: ev.isError });
      if (ev.type === "done") {
        usage = ev.usage;
        if (ev.engineSessionId) engineSessionId = ev.engineSessionId;
        break;
      }
      yield ev;
    }
  } catch (err) {
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    running.delete(session.id);
  }

  if (engineSessionId && engineSessionId !== session.engine_session_id) {
    sessions.update(session.id, { engine_session_id: engineSessionId });
  }
  const saved = messages.add({
    session_id: session.id,
    role: "assistant",
    content: text,
    model,
    tools_json: tools.length ? JSON.stringify(tools) : null,
    usage_json: usage ? JSON.stringify(usage) : null,
  });
  sessions.update(session.id, {});

  // Fire-and-forget: long-term memory shouldn't slow the UI down.
  if (text.trim()) {
    const fresh = sessions.get(session.id)!;
    void archiveTurn({
      sessionId: session.id,
      sessionTitle: fresh.title,
      messageId: saved.id,
      engine: session.engine,
      model,
      user: prompt,
      assistant: text,
    });
  }

  yield { type: "done", engineSessionId: engineSessionId ?? "", usage, messageId: saved.id };
}
