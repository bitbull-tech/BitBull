/**
 * Engine-neutral contract. Every agent runtime (Claude Agent SDK, OpenCode, …)
 * adapts its native stream into these events so the API + UI never care which
 * engine is underneath.
 */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_end"; id: string; output?: string; isError?: boolean }
  | { type: "done"; engineSessionId: string; usage?: Usage }
  | { type: "error"; message: string };

export interface Usage {
  inputTokens?: number;
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
}

export interface AgentEngine {
  id: "opencode" | "claude";
  label: string;
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
