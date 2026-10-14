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

/** Network-level failures worth retrying (proxy restarting, connection reset, timeout). */
const transient = (msg: string) => /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|fetch failed|terminated|timeout|50[234]/i.test(msg);

/**
 * Call a Ditto tool. Transient network errors are retried with backoff (1s, 5s, 15s): writes
 * use a vendorId, so a retried save can't create duplicates.
 */
export async function dittoCall(name: string, args: Record<string, unknown>, retries = [1000, 5000, 15000]) {
  if (!dittoEnabled()) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await getClient();
      const res = await c.callTool({ name, arguments: args });
      if (attempt > 0) console.log(`[ditto] ${name} succeeded on retry ${attempt}`);
      return res;
    } catch (err) {
      client = null; // force reconnect next time
      const msg = errText(err);
      if (attempt < retries.length && transient(msg)) {
        console.warn(`[ditto] ${name} failed (${msg}); retrying in ${retries[attempt] / 1000}s`);
        await new Promise((r) => setTimeout(r, retries[attempt]));
        continue;
      }
      console.error(`[ditto] ${name} failed:`, msg);
      return null;
    }
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

/**
 * Index a file stored on Hippius. Hippius holds the bytes; this memory is how they are
 * found again — "the photo of Grandad's squadron" searches Ditto and gets back a key.
 */
export async function indexFile(f: {
  name: string;
  project?: string;
  relPath: string;
  key: string;
  bucket: string;
  sha256: string;
  size: number;
}) {
  if (!dittoEnabled()) return;
  const mb = f.size / 1024 / 1024;
  const content = [
    `File "${f.name}"${f.project ? ` in project "${f.project}"` : ""} (SayGM Agent)`,
    "",
    `Stored on Hippius at hippius:${f.bucket}/${f.key} (encrypted; restore it through GM).`,
    `In the workspace at ${f.relPath}. ${mb < 0.1 ? `${f.size} bytes` : `${mb.toFixed(1)} MB`}, sha256 ${f.sha256}.`,
  ].join("\n");
  await dittoCall("save_memory", {
    content,
    source: config.ditto.source,
    sourceContext: f.project ? `project:${f.project}` : "files",
    // Content-addressed: re-storing the same bytes at the same key won't duplicate the memory
    vendorId: `file:${f.key}:${f.sha256.slice(0, 16)}`,
    metadata: { kind: "stored-file", name: f.name, key: f.key, bucket: f.bucket, sha256: f.sha256, size: f.size, project: f.project ?? null },
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
