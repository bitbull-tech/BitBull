import { errText } from "./models.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";

/**
 * Ditto (heyditto.ai) is the long-term memory layer.
 *  - The AGENT talks to Ditto through MCP tools (search_memories, save_memory, …)
 *    wired into whichever engine is running.
 *  - The SERVER also talks to Ditto directly (this file) to archive every turn and
 *    to back up skills, so nothing depends on the model remembering to save.
 */

export function dittoMcpHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${config.ditto.apiKey}` };
}

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const c = new Client({ name: "saygm-agent", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(config.ditto.mcpUrl), {
      requestInit: { headers: dittoMcpHeaders() },
    });
    await c.connect(transport);
    client = c;
    return c;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Drop the cached connection (after the key or URL changes in Settings). */
export function resetDitto() {
  const c = client;
  client = null;
  connecting = null;
  void c?.close().catch(() => {});
}

export const dittoEnabled = () => !!config.ditto.apiKey;

export async function dittoCall(name: string, args: Record<string, unknown>) {
  if (!dittoEnabled()) return null;
  try {
    const c = await getClient();
    return await c.callTool({ name, arguments: args });
  } catch (err) {
    client = null; // force reconnect next time
    console.error(`[ditto] ${name} failed:`, errText(err));
    return null;
  }
}

/** Archive one user→assistant exchange. vendorId makes retries idempotent. */
export async function archiveTurn(t: {
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  engine: string;
  model: string;
  project?: string;
  user: string;
  assistant: string;
}) {
  if (config.ditto.archive === "off") return;
  const content = [
    `Conversation "${t.sessionTitle}"${t.project ? ` in project "${t.project}"` : ""} (SayGM Agent, ${t.engine} / ${t.model})`,
    "",
    `${config.ownerName}: ${t.user}`,
    "",
    `Agent: ${t.assistant}`,
  ].join("\n");
  await dittoCall("save_memory", {
    content: content.slice(0, 20000),
    source: config.ditto.source,
    sourceContext: t.project ? `project:${t.project}` : `session:${t.sessionId}`,
    vendorId: `turn:${t.messageId}`,
    metadata: { sessionId: t.sessionId, engine: t.engine, model: t.model, project: t.project ?? null, kind: "chat-turn" },
  });
}

/** Back up a skill file to Ditto (idempotent by skill name + content hash). */
export async function backupSkill(name: string, markdown: string, hash: string) {
  await dittoCall("save_memory", {
    content: `SayGM Agent skill "${name}":\n\n${markdown}`.slice(0, 20000),
    source: config.ditto.source,
    sourceContext: `skill:${name}`,
    vendorId: `skill:${name}:${hash}`,
    metadata: { kind: "skill", name, hash },
  });
}

export async function listDittoTools(): Promise<string[]> {
  if (!dittoEnabled()) return [];
  try {
    const c = await getClient();
    const { tools } = await c.listTools();
    return tools.map((t) => t.name);
  } catch {
    client = null;
    return [];
  }
}

/** Fresh connection attempt that reports the real error (used by /api/debug). */
export async function probeDitto() {
  if (!dittoEnabled()) return { enabled: false };
  try {
    const c = new Client({ name: "saygm-agent-probe", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(config.ditto.mcpUrl), {
      requestInit: { headers: dittoMcpHeaders() },
    });
    await c.connect(transport);
    const { tools } = await c.listTools();
    await c.close();
    return { enabled: true, ok: true, tools: tools.map((t) => t.name) };
  } catch (e) {
    const err = e as Error & { code?: unknown; cause?: unknown };
    return { enabled: true, ok: false, error: `${err.name}: ${err.message}`, code: err.code, cause: String(err.cause ?? "") };
  }
}
