/**
 * Engine-neutral contract. Every agent runtime (Claude Agent SDK, OpenCode, …)
 * adapts its native stream into these events so the API + UI never care which
 * engine is underneath.
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  // parent = id of the subagent (task) tool call this tool ran under
  | { type: "tool_start"; id: string; name: string; input?: unknown; parent?: string }
  | { type: "tool_end"; id: string; output?: string; isError?: boolean; parent?: string }
  | { type: "done"; engineSessionId: string; usage?: Usage }
  | { type: "error"; message: string };

export interface Usage {
  inputTokens?: number;
  /** part of inputTokens that was served from the prompt cache (cheaper) */
  cacheReadTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface RunInput {
  /** Engine-native session id to continue, or null for a fresh conversation. */
  engineSessionId: string | null;
  model: string;
  prompt: string;
  systemPrompt: string;
  signal: AbortSignal;
  /** Working directory for tools: the project's workspace (or the general one) */
  cwd: string;
  /** Integration MCP servers enabled for this chat's project */
  mcp: Record<string, { url: string; headers: Record<string, string> }>;
  /** BitBull's chat id (lets BitBull's own MCP tools say which chat asked) */
  bitbullSessionId?: string;
  /** Read-only planning turn: investigate and propose, change nothing */
  plan?: boolean;
}

export interface AgentEngine {
  id: "opencode" | "claude";
  label: string;
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
