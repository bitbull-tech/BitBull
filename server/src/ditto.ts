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

/**
 * Ditto groups saves into "sessions" (threads). Sent with these headers, a BitBob chat's
 * archive lands in one Ditto thread named like the chat, instead of Ditto's time-based
 * grouping that lumps unrelated chats together. The name header goes out once per thread.
 */
export const DITTO_SESSION_HEADER = "X-Ditto-Session-Id";
export const DITTO_SESSION_NAME_HEADER = "X-Ditto-Session-Name";
export interface DittoThread {
  id: string;
  title?: string;
}

interface Conn {
  client: Client;
  lastUsed: number;
}
/** One connection per Ditto thread (key "" = none); idle ones are closed after a while. */
const conns = new Map<string, Conn>();
const connecting = new Map<string, Promise<Client>>();
const IDLE_MS = 10 * 60 * 1000;
const named = new Set<string>();

async function getClient(thread?: DittoThread): Promise<Client> {
  const key = thread?.id ?? "";
  const cur = conns.get(key);
  if (cur) {
    cur.lastUsed = Date.now();
    return cur.client;
  }
  const inflight = connecting.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const c = new Client({ name: "bitbob", version: "0.1.0" });
    const headers: Record<string, string> = { ...dittoMcpHeaders() };
    if (thread) {
      headers[DITTO_SESSION_HEADER] = thread.id;
      // the title once: the first connection for this thread in this process carries it
      if (thread.title && !named.has(thread.id)) {
        headers[DITTO_SESSION_NAME_HEADER] = thread.title.replace(/[\r\n]+/g, " ").slice(0, 120);
        named.add(thread.id);
      }
    }
    const transport = new StreamableHTTPClientTransport(new URL(config.ditto.mcpUrl), { requestInit: { headers } });
    await c.connect(transport);
    conns.set(key, { client: c, lastUsed: Date.now() });
    return c;
  })();
  connecting.set(key, p);
  try {
    return await p;
  } finally {
    connecting.delete(key);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, c] of conns) {
    if (k !== "" && now - c.lastUsed > IDLE_MS) {
      conns.delete(k);
      void c.client.close().catch(() => {});
    }
  }
}, 60_000).unref();

/** Drop the cached connections (after the key or URL changes in Settings). */
export function resetDitto() {
  for (const c of conns.values()) void c.client.close().catch(() => {});
  conns.clear();
  connecting.clear();
  named.clear();
}

export const dittoEnabled = () => !!config.ditto.apiKey;

/** Network-level failures worth retrying (proxy restarting, connection reset, timeout). */
const transient = (msg: string) => /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|fetch failed|terminated|timeout|50[234]/i.test(msg);

/**
 * Call a Ditto tool. Transient network errors are retried with backoff (1s, 5s, 15s): writes
 * use a vendorId, so a retried save can't create duplicates.
 */
export async function dittoCall(name: string, args: Record<string, unknown>, retries = [1000, 5000, 15000], thread?: DittoThread) {
  if (!dittoEnabled()) return null;
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await getClient(thread);
      const res = await c.callTool({ name, arguments: args });
      if (attempt > 0) console.log(`[ditto] ${name} succeeded on retry ${attempt}`);
      return res;
    } catch (err) {
      conns.delete(thread?.id ?? ""); // force reconnect next time
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
    `Conversation "${t.sessionTitle}"${t.project ? ` in project "${t.project}"` : ""} (BitBob, ${t.engine} / ${t.model})`,
    "",
    `${config.ownerName}: ${t.user}`,
    "",
    `Agent: ${t.assistant}`,
  ].join("\n");
  await dittoCall(
    "save_memory",
    {
      // Ditto memories are capped at 20k characters: the full turn stays in local SQLite (messages),
      // the memory is the searchable archive. Long tool outputs are what gets cut.
      content: content.slice(0, 20000),
      source: config.ditto.source,
      sourceContext: t.project ? `project:${t.project}` : `session:${t.sessionId}`,
      vendorId: `turn:${t.messageId}`,
      metadata: { sessionId: t.sessionId, engine: t.engine, model: t.model, project: t.project ?? null, kind: "chat-turn" },
    },
    undefined,
    // one Ditto thread per BitBob chat, titled like it (project first so threads sort together)
    { id: t.sessionId, title: t.project ? `${t.project} · ${t.sessionTitle}` : t.sessionTitle },
  );
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
    `File "${f.name}"${f.project ? ` in project "${f.project}"` : ""} (BitBob)`,
    "",
    `Stored on Hippius at hippius:${f.bucket}/${f.key} (encrypted; restore it through BitBob).`,
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
    content: `BitBob skill "${name}":\n\n${markdown}`.slice(0, 20000),
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
    conns.delete("");
    return [];
  }
}

/** Fresh connection attempt that reports the real error (used by /api/debug). */
export async function probeDitto() {
  if (!dittoEnabled()) return { enabled: false };
  try {
    const c = new Client({ name: "bitbob-probe", version: "0.1.0" });
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
