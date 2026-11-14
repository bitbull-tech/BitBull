/**
 * Long text pasted into the composer is sent as an attachment (pasted-text.txt) instead of filling
 * the conversation. Three things keep that from hiding anything:
 *
 *  - the model still gets the words: runTurn puts a pasted file's text into the prompt it sends
 *    (pastedNote), so no tool call is needed to read it;
 *  - the owner can open it again from the message (pastedContent);
 *  - searching chats finds it (searchChats looks in messages and in pasted text).
 *
 * The text is kept in the database as well as the workspace file, so search and preview don't
 * depend on a file the agent's shell could have changed or removed.
 */
import { db } from "./db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS pasted_text (
  path TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);
`);

/** uploads/<chat>/pasted-text.txt, pasted-text-1.txt, … */
export const isPastedPath = (p: string) => /^uploads\/[^/]+\/pasted-text(-\d+)?\.txt$/.test(p);
export const isPastedName = (name: string) => /^pasted-text(-\d+)?\.txt$/.test(name);

/** The most pasted text kept for search and preview, and put into a prompt, per paste. */
export const PASTE_KEEP_CHARS = 400_000;
export const PASTE_INLINE_CHARS = 120_000;

export function rememberPasted(sessionId: string, path: string, content: string) {
  db.prepare("INSERT OR REPLACE INTO pasted_text (path, session_id, content, created_at) VALUES (?,?,?,?)").run(path, sessionId, content.slice(0, PASTE_KEEP_CHARS), Date.now());
}

export function pastedContent(sessionId: string, path: string): string | undefined {
  return (db.prepare("SELECT content FROM pasted_text WHERE session_id = ? AND path = ?").get(sessionId, path) as { content?: string } | undefined)?.content;
}

/** What is added to the prompt for the pasted files among a turn's attachments. */
export function pastedNote(sessionId: string, attachments: string[]): string {
  const parts: string[] = [];
  for (const p of attachments.filter(isPastedPath)) {
    const text = pastedContent(sessionId, p);
    if (text === undefined) continue;
    const name = p.split("/").pop();
    if (text.length > PASTE_INLINE_CHARS) {
      parts.push(`Pasted text (${name}, ${text.length.toLocaleString("en")} characters): too long to include here; read it from ${p} with your tools.`);
      continue;
    }
    // a fence the pasted text can't close early
    let fence = "~~~~";
    while (text.includes(fence)) fence += "~";
    parts.push(`Pasted text (the user pasted this into the message; it is shown to them as the attachment ${name}):\n${fence}\n${text}\n${fence}`);
  }
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

export interface ChatHit {
  sessionId: string;
  where: "message" | "pasted";
  snippet: string;
}

const likeEscape = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);
function snippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const from = Math.max(0, i - 40);
  return `${from > 0 ? "…" : ""}${text.slice(from, i + q.length + 80).replace(/\s+/g, " ").trim()}${i + q.length + 80 < text.length ? "…" : ""}`;
}

/** Chats whose messages or pasted text contain `q` (case-insensitive), one hit per chat. */
export function searchChats(q: string, limit = 200): ChatHit[] {
  const needle = q.trim();
  if (needle.length < 2) return [];
  const like = `%${likeEscape(needle)}%`;
  const hits = new Map<string, ChatHit>();
  const inMessages = db
    .prepare("SELECT session_id, content FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
    .all(like, limit * 3) as Array<{ session_id: string; content: string }>;
  for (const r of inMessages) if (!hits.has(r.session_id)) hits.set(r.session_id, { sessionId: r.session_id, where: "message", snippet: snippet(r.content, needle) });
  const inPasted = db
    .prepare("SELECT session_id, content FROM pasted_text WHERE content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
    .all(like, limit) as Array<{ session_id: string; content: string }>;
  for (const r of inPasted) if (!hits.has(r.session_id)) hits.set(r.session_id, { sessionId: r.session_id, where: "pasted", snippet: snippet(r.content, needle) });
  return [...hits.values()].slice(0, limit);
}
