import { CLAUDE_READ_ONLY_DISALLOWED, listSubagents } from "../subagents.js";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, paths, shellAllowed } from "../config.js";
import { dittoMcpHeaders } from "../ditto.js";
import { bitbullMcpServer } from "../mcp.js";
import { LINKS_ROOT, linksAvailable } from "../links.js";
import type { AgentEngine, AgentEvent, RunInput } from "./types.js";
import { chatModels, routerRefusal, type ModelInfo } from "../models.js";
import { reviewModelId, ROUTER_HEADERS, ROUTER_SESSION_HEADER, routerBackground, routerBaseUrl, routerMcpServers, routerModelId, routerReview } from "../router.js";

/**
 * Host env minus any Anthropic/Claude credentials, so a logged-in Claude Code
 * (or a stray ANTHROPIC_* var) can never be sent to the gateway instead of the
 * gateway's own key.
 */
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDECODE$|CLAUDE_AGENT_)/.test(k)) continue;
    // BitBull's own credentials: the CLI gets MCP auth in its config, not from env, and its shell shouldn't see them
    if (/^(SAYGM_API_KEY|DITTO_API_KEY|DITTO_ROUTER_KEY|DITTO_ROUTER_REVIEW_KEY|APP_TOKEN|ATLAS_API_KEY|HIPPIUS_.*|OPENCODE_CONFIG_CONTENT)$/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Engine 1: Claude Agent SDK, pointed at the model's gateway's Anthropic-compatible endpoint:
 * SayGM's (Claude models), or Ditto Router's (/v1/messages, any Router model, the way
 * `heyditto claude` runs Claude Code). Best-in-class agent loop/tools for Claude models.
 */
export const claudeEngine: AgentEngine = {
  id: "claude",
  label: "Claude Agent SDK",

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const [models] = await Promise.all([chatModels(), routerReview()]);
    const m = models.find((x) => x.id === input.model);
    const viaRouter = routerModelId(input.model) !== null;
    // One gateway per turn. SayGM's Anthropic API serves its Claude models; the Router's
    // translates, so every Router model runs here.
    const runsHere = (x: ModelInfo | undefined): x is ModelInfo => !!x && (x.gateway === "ditto-router" ? viaRouter : !viaRouter && x.api === "anthropic");
    const refusal =
      routerRefusal(input.model, m, input.plan) ??
      (m && !runsHere(m) ? `${input.model} isn't served on SayGM's Anthropic API, so the Claude Agent SDK engine can't use it. Start an OpenCode chat for this model.` : null);
    if (refusal) {
      yield { type: "error", message: refusal };
      yield { type: "done", engineSessionId: input.engineSessionId ?? "" };
      return;
    }
    const abort = new AbortController();
    input.signal.addEventListener("abort", () => abort.abort(), { once: true });

    // The CLI talks to one gateway per turn: the chat model's. On the Router (as `heyditto claude`
    // runs Claude Code), the turn joins the chat's Router thread, requests say whether they are the
    // main loop, a subagent or housekeeping, and background work runs on the Router's background
    // model or this one. Plan mode runs on the review endpoint (no memory, checked by routerRefusal),
    // background calls included, and the chat endpoint's own entry becomes the review endpoint's.
    const session = input.bitbullSessionId ? { [ROUTER_SESSION_HEADER]: input.bitbullSessionId } : {};
    const routerHeaders = { ...ROUTER_HEADERS, ...session };
    const gatewayEnv: Record<string, string> = viaRouter
      ? {
          ANTHROPIC_BASE_URL: routerBaseUrl().replace(/\/v1$/, ""),
          ANTHROPIC_AUTH_TOKEN: input.plan ? config.router.reviewKey : config.router.key,
          ANTHROPIC_CUSTOM_HEADERS: Object.entries(routerHeaders).map(([k, v]) => `${k}: ${v}`).join("\n"),
          CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1",
        }
      : {
          ANTHROPIC_BASE_URL: config.saygm.anthropicBaseUrl,
          ...(config.saygm.anthropicAuth === "bearer" ? { ANTHROPIC_AUTH_TOKEN: config.saygm.apiKey } : { ANTHROPIC_API_KEY: config.saygm.apiKey }),
        };
    // the id the gateway knows a model by (on the review endpoint in plan mode)
    const gatewayId = (x: { id: string; endpoint?: boolean }) => {
      const routerId = routerModelId(x.id);
      return routerId === null ? x.id : input.plan ? reviewModelId({ id: routerId, endpoint: x.endpoint }) : routerId;
    };
    const model = gatewayId(m ?? { id: input.model });
    const smallModel = !viaRouter ? config.agent.smallModel : input.plan ? model : (routerBackground()?.model ?? model);

    // Subagents (reviewer, challenger, …) via the SDK's Task/Agent tool; others inherit the chat's model
    const agents = Object.fromEntries(
      listSubagents().map((a) => {
        const sm = a.model === "inherit" ? undefined : models.find((x) => x.id === a.model);
        return [
          a.name,
          {
            description: a.description,
            prompt: a.prompt,
            model: runsHere(sm) ? gatewayId(sm) : "inherit",
            // read-only: no file edits, no shell, no starting other agents
            ...(a.access === "read" ? { disallowedTools: CLAUDE_READ_ONLY_DISALLOWED } : {}),
          },
        ];
      }),
    );

    const bitbullMcp = bitbullMcpServer(input.bitbullSessionId);
    // The Router endpoint's tools (memory included), attached here so plan mode can leave them out
    const routerMcp = input.plan ? [] : await routerMcpServers();
    const denied = [
      ...(shellAllowed() ? [] : ["Bash", "BashOutput", "KillShell"]),
      ...routerMcp.flatMap((r) => r.deny.map((t) => `mcp__${r.name}__${t}`)),
    ];
    const options: Options = {
      agents,
      model,
      cwd: input.cwd,
      // read-only links from the user's computer (the mount itself refuses writes)
      ...(linksAvailable() ? { additionalDirectories: [LINKS_ROOT] } : {}),
      abortController: abort,
      includePartialMessages: true,
      // Loads skills from <workspace>/.claude/skills (synced from repo /skills)
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code", append: input.systemPrompt },
      // Plan mode = Claude Code's own read-only planning mode
      permissionMode: (input.plan ? "plan" : shellAllowed() ? config.agent.permissionMode : "acceptEdits") as Options["permissionMode"],
      allowDangerouslySkipPermissions: !input.plan && shellAllowed(),
      // No sandbox: no shell. File edits stay inside the workspace (acceptEdits). Tools the Router
      // endpoint wants approved in the client are refused: nobody can answer mid-turn here.
      ...(denied.length ? { disallowedTools: denied } : {}),
      ...(input.engineSessionId ? { resume: input.engineSessionId } : {}),
      // Plan mode attaches no MCP servers at all, same rule as the OpenCode engine: plan mode is
      // where agents read hostile content, and these tools write to memory or ask the owner for
      // network access. Not attaching them beats disallowing tools by name. (2026-11 swarm.)
      mcpServers: input.plan ? {} : {
        ...(config.ditto.apiKey && !routerMcp.some((r) => r.name === "ditto") ? { ditto: { type: "http" as const, url: config.ditto.mcpUrl, headers: dittoMcpHeaders() } } : {}),
        ...Object.fromEntries(routerMcp.map((r) => [r.name, { type: "http" as const, url: r.url, headers: { ...r.headers, ...session } }])),
        ...Object.fromEntries(Object.entries(input.mcp).map(([k, v]) => [k, { type: "http" as const, ...v }])),
        // BitBull's own tools (network access requests); tagged with this chat
        ...(bitbullMcp ? { bitbull: { type: "http" as const, ...bitbullMcp } } : {}),
      },
      env: {
        ...cleanEnv(),
        ...gatewayEnv,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
        ANTHROPIC_SMALL_FAST_MODEL: smallModel,
        CLAUDE_CONFIG_DIR: paths.claudeConfig,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        // request_network_access waits for the user; don't time the call out before it does
        MCP_TOOL_TIMEOUT: "660000",
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
                yield { type: "tool_start", id: block.id, name: block.name, input: block.input, ...(msg.parent_tool_use_id ? { parent: msg.parent_tool_use_id } : {}) };
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
                  yield {
                    type: "tool_end",
                    id: block.tool_use_id,
                    output: out.slice(0, 20000),
                    isError: !!block.is_error,
                    ...(msg.parent_tool_use_id ? { parent: msg.parent_tool_use_id } : {}),
                  };
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
                inputTokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0),
                cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
                outputTokens: msg.usage?.output_tokens,
                // total_cost_usd is an Anthropic list-price estimate, not gateway billing — omitted.
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
