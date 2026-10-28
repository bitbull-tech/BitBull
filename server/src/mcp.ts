import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { config } from "./config.js";
import { sessions } from "./db.js";
import { proxied, requestAccess } from "./egress.js";

/**
 * GM's own MCP server, attached to both engines as "gm": tools that need the user or the
 * server rather than the sandbox. Today: request_network_access.
 *
 * Reached on the loopback interface only, with a token minted at startup (never written
 * anywhere). The token is not a security boundary against the agent itself (it could read
 * it from its engine's config); it stops anything else on the network from calling in.
 * The tools only ever *ask* the user.
 */

export const MCP_PATH = "/mcp/gm";
const TOKEN = randomBytes(24).toString("hex");
export const GM_MCP_HEADER = "x-gm-internal";

/** Chats with a turn running right now (to say which chat a request came from). */
let runningSessions: () => string[] = () => [];
export function setRunningSessions(fn: () => string[]) {
  runningSessions = fn;
}

export const gmMcpEnabled = () => proxied();

/** Connection details for the engines; sessionId is added when the engine runs per chat. */
export function gmMcpServer(sessionId?: string): { url: string; headers: Record<string, string> } | null {
  if (!gmMcpEnabled()) return null;
  return {
    url: `http://127.0.0.1:${config.port}${MCP_PATH}`,
    headers: { [GM_MCP_HEADER]: TOKEN, ...(sessionId ? { "x-gm-session": sessionId } : {}) },
  };
}

export function mcpTokenOk(given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function build(sessionHint: string | undefined) {
  const server = new McpServer({ name: "gm", version: "1.0.0" });
  server.registerTool(
    "request_network_access",
    {
      title: "Ask the user for network access",
      description:
        "Ask the user to let the sandbox reach a domain that the egress proxy refused (HTTP 403 from the proxy, 'CONNECT tunnel failed', 'Forbidden'). " +
        "Give the exact host and one sentence the user can judge: what you need from it and why. The call waits for the user's answer (up to a few minutes). " +
        "Only ask for domains the task really needs; never try to get round the proxy instead.",
      inputSchema: {
        domain: z.string().describe("Host name, e.g. api.example.com (a URL is fine; no IP addresses)"),
        reason: z.string().describe("Why you need it, in one sentence the user can judge"),
      },
    },
    async ({ domain, reason }) => {
      // Which chat is asking: the engine says so (Claude engine), or the only one running
      const live = runningSessions();
      const sid = sessionHint && sessions.get(sessionHint) ? sessionHint : live.length === 1 ? live[0] : undefined;
      const title = sid ? sessions.get(sid)?.title : undefined;
      const r = await requestAccess({ domain, reason, sessionId: sid, sessionTitle: title });
      return { content: [{ type: "text" as const, text: r.text }] };
    },
  );
  return server;
}

/** Stateless Streamable HTTP: a fresh server per request (tools keep their state in egress.ts). */
export async function handleMcp(req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = build(req.headers.get("x-gm-session") ?? undefined);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // the response body is fully built (JSON mode), so the pair can go
    void server.close().catch(() => {});
  }
}
