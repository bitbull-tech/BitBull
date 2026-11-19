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
  // running total so far, while the turn is still going (lets QA Hound enforce a budget mid-turn)
  | { type: "usage"; usage: Usage }
  // transient: the engine is trying the model call again (a dropped connection, a busy model);
  // the turn is still going and has not failed. Without it, the turn has failed.
  | { type: "error"; message: string; transient?: boolean };

/**
 * A failure that is about the connection or a busy model, not about the request: worth trying
 * again, and worth more patience than two attempts. (A locked screen, a laptop that dropped Wi-Fi
 * for ten seconds, a VPN reconnecting, a gateway restarting.)
 */
export function isTransientFailure(message: string | undefined): boolean {
  return /socket connection was closed|cannot connect to api|unable to connect|connection (error|reset|refused|closed|terminated)|econnreset|econnrefused|etimedout|enotfound|eai_again|enetunreach|ehostunreach|epipe|fetch failed|network|timed? ?out|\b(408|425|429|500|502|503|504|520|522|524|529)\b|overloaded|temporarily|unavailable|model_cooling|rate.?limit|try again/i.test(
    message ?? "",
  );
}

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
  /**
   * A QA Hound reviewer with "Run it in a confidential sandbox" ticked: in plan mode, the one Cathedral
   * tool review_exec stays on (it runs commands only in the room that run created). Ignored otherwise.
   */
  reviewSandbox?: boolean;
  /** Environment variables this chat's agent isn't given (projectGates.ts: GitHub in a project that hasn't ticked it). */
  withholdEnv?: string[];
  /** One of a Dog Pound's dogs at work (pound.ts): it can't hand work on, so the pound's tools are off. */
  noDelegate?: boolean;
}

export interface AgentEngine {
  id: "opencode" | "claude";
  label: string;
  run(input: RunInput): AsyncIterable<AgentEvent>;
}
