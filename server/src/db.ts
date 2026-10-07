import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { paths, type EngineId } from "./config.js";

export const db = new Database(paths.db);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  engine_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  model TEXT,
  tools_json TEXT,
  usage_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`);

export interface SessionRow {
  id: string;
  title: string;
  engine: EngineId;
  model: string;
  engine_session_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  tools_json: string | null;
  usage_json: string | null;
  created_at: number;
}

export const sessions = {
  list(): SessionRow[] {
    return db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[];
  },
  get(id: string): SessionRow | undefined {
    return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  },
  create(input: { title?: string; engine: EngineId; model: string }): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      id: randomUUID(),
      title: input.title ?? "New chat",
      engine: input.engine,
      model: input.model,
      engine_session_id: null,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      "INSERT INTO sessions (id,title,engine,model,engine_session_id,created_at,updated_at) VALUES (@id,@title,@engine,@model,@engine_session_id,@created_at,@updated_at)",
    ).run(row);
    return row;
  },
  update(id: string, patch: Partial<Pick<SessionRow, "title" | "model" | "engine_session_id">>) {
    const cur = sessions.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updated_at: Date.now() };
    db.prepare(
      "UPDATE sessions SET title=@title, model=@model, engine_session_id=@engine_session_id, updated_at=@updated_at WHERE id=@id",
    ).run(next);
    return next;
  },
  delete(id: string) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  },
};

export const messages = {
  list(sessionId: string): MessageRow[] {
    return db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as MessageRow[];
  },
  add(m: Omit<MessageRow, "id" | "created_at">): MessageRow {
    const row: MessageRow = { ...m, id: randomUUID(), created_at: Date.now() };
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,model,tools_json,usage_json,created_at) VALUES (@id,@session_id,@role,@content,@model,@tools_json,@usage_json,@created_at)",
    ).run(row);
    return row;
  },
};
