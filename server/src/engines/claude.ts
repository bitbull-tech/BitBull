import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, paths } from "../config.js";
import { dittoMcpHeaders } from "../ditto.js";
import type { AgentEngine, AgentEvent, RunInput } from "./types.js";
import { listModels } from "../models.js";

/**
 * Host env minus any Anthropic/Claude credentials, so a logged-in Claude Code
 * (or a stray ANTHROPIC_* var) can never be sent to the gateway instead of the
 * SayGM key.
 */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDECODE$|CLAUDE_AGENT_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Engine 1: Claude Agent SDK, pointed at SayGM's Anthropic-compatible endpoint.
 * Best-in-class agent loop/tools for Claude models. Non-Claude models only work
 * if SayGM translates them behind /v1/messages.
 */
export const claudeEngine: AgentEngine = {
  id: "claude",
  label: "Claude Agent SDK",

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const m = (await listModels()).find((x) => x.id === input.model);
    if (m && m.api !== "anthropic") {
      yield { type: "error", message: `${input.model} isn't served on SayGM's Anthropic API, so the Claude Agent SDK engine can't use it. Start an OpenCode chat for this model.` };
      yield { type: "done", engineSessionId: input.engineSessionId ?? "" };
      return;
    }
    const abort = new AbortController();
    input.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const authEnv =
      config.saygm.anthropicAuth === "bearer"
        ? { ANTHROPIC_AUTH_TOKEN: config.saygm.apiKey }
        : { ANTHROPIC_API_KEY: config.saygm.apiKey };

    const options: Options = {
      model: input.model,
      cwd: paths.workspace,
      abortController: abort,
      includePartialMessages: true,
      // Loads skills from <workspace>/.claude/skills (synced from repo /skills)
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt },
      permissionMode: config.agent.permissionMode as Options["permissionMode"],
      allowDangerouslySkipPermissions: config.agent.permissionMode === "bypassPermissions",
      ...(input.engineSessionId ? { resume: input.engineSessionId } : {}),
      mcpServers: config.ditto.apiKey
        ? { ditto: { type: "http", url: config.ditto.mcpUrl, headers: dittoMcpHeaders() } }
        : {},
      env: {
        ...cleanEnv(),
        ...authEnv,
        ANTHROPIC_BASE_URL: config.saygm.anthropicBaseUrl,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: config.agent.smallModel,
        ANTHROPIC_SMALL_FAST_MODEL: config.agent.smallModel,
        CLAUDE_CONFIG_DIR: paths.claudeConfig,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
      },
    };

    const openTools = new Set<string>();
    let sessionId = input.engineSessionId ?? "";
    let sawStreamText = false;

    try {
      for await (const msg of query({ prompt: input.prompt, options }) as AsyncIterable<SDKMessage>) {
        if ("session_id" in msg && msg.session_id) sessionId = msg.session_id;

        switch (msg.type) {
          case "stream_event": {
            if (msg.parent_tool_use_id) break; // sub-agent chatter
            const ev = msg.event;
            if (ev.type === "content_block_delta") {
              if (ev.delta.type === "text_delta") {
                sawStreamText = true;
                yield { type: "text", delta: ev.delta.text };
              } else if (ev.delta.type === "thinking_delta") {
                yield { type: "thinking", delta: ev.delta.thinking };
              }
            }
            break;
          }
          case "assistant": {
            for (const block of msg.message.content) {
              if (block.type === "tool_use" && !openTools.has(block.id)) {
                openTools.add(block.id);
                yield { type: "tool_start", id: block.id, name: block.name, input: block.input };
              } else if (block.type === "text" && !sawStreamText && !msg.parent_tool_use_id) {
                // Fallback if the gateway doesn't stream partials
                yield { type: "text", delta: block.text };
              }
            }
            sawStreamText = false;
            break;
          }
          case "user": {
            const content = msg.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block === "object" && block && "type" in block && block.type === "tool_result") {
                  const out = Array.isArray(block.content)
                    ? block.content.map((c) => ("text" in c ? c.text : "")).join("\n")
                    : String(block.content ?? "");
                  openTools.delete(block.tool_use_id);
                  yield { type: "tool_end", id: block.tool_use_id, output: out.slice(0, 4000), isError: !!block.is_error };
                }
              }
            }
            break;
          }
          case "result": {
            if (msg.subtype !== "success" || msg.is_error) {
              const detail = "errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : msg.subtype;
              yield { type: "error", message: `Agent ended with ${detail}` };
            }
            yield {
              type: "done",
              engineSessionId: sessionId,
              usage: {
                inputTokens: msg.usage?.input_tokens,
                outputTokens: msg.usage?.output_tokens,
                // total_cost_usd is an Anthropic list-price estimate, not SayGM billing — omitted.
              },
            };
            return;
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        yield { type: "done", engineSessionId: sessionId };
        return;
      }
      yield { type: "error", message: err instanceof Error ? err.message : String(err) };
      yield { type: "done", engineSessionId: sessionId };
    }
  },
};
