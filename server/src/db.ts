import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { paths, type EngineId } from "./config.js";

// Node's built-in SQLite: no native module to compile, works on Windows/macOS/Linux as-is.
export const db = new DatabaseSync(paths.db);
// WAL by default; SQLITE_JOURNAL=DELETE for bind mounts where shared-memory locking is unreliable (Docker Desktop on Windows)
db.exec(`PRAGMA journal_mode = ${/^(DELETE|TRUNCATE|WAL)$/.test(process.env.SQLITE_JOURNAL ?? "") ? process.env.SQLITE_JOURNAL : "WAL"}; PRAGMA foreign_keys = ON;`);

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
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'indigo',
  dir TEXT NOT NULL,
  integrations_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One row per turn, plus its event stream, so a client that goes away (phone locked,
-- laptop asleep, tunnel blip) can re-attach and replay instead of losing the turn.
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, started_at DESC);
CREATE TABLE IF NOT EXISTS turn_events (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, seq)
);
`);

// Migrations for databases created before projects existed
const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
if (!cols.includes("project_id")) db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL");

// Engine sessions are tied to absolute workspace paths. If the workspace root moved
// (e.g. host → Docker), drop them; the next turn replays history instead.
db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
{
  const prev = (db.prepare("SELECT value FROM meta WHERE key = 'workspace_root'").get() as { value?: string } | undefined)?.value;
  if (prev !== paths.workspace) {
    if (prev) {
      db.exec("UPDATE sessions SET engine_session_id = NULL");
      console.log(`[db] workspace root changed (${prev} → ${paths.workspace}); engine sessions reset, history will be replayed`);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('workspace_root', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(paths.workspace);
  }
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  color: string;
  /** Folder name under DATA_DIR/projects: the project's agent workspace */
  dir: string;
  integrations_json: string;
  created_at: number;
  updated_at: number;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";

/** Absolute workspace folder for a project, or the general workspace. */
export function workspaceFor(project?: ProjectRow | null) {
  return project ? path.join(paths.projects, project.dir) : paths.workspace;
}

export const projects = {
  list(): ProjectRow[] {
    return db.prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() as unknown as ProjectRow[];
  },
  get(id: string | null | undefined): ProjectRow | undefined {
    if (!id) return undefined;
    return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
  },
  create(input: { name: string; description?: string; instructions?: string; color?: string; integrations?: string[] }): ProjectRow {
    const now = Date.now();
    const id = randomUUID();
    const row: ProjectRow = {
      id,
      name: input.name.trim(),
      description: input.description ?? "",
      instructions: input.instructions ?? "",
      color: input.color ?? "indigo",
      dir: `${slug(input.name)}-${id.slice(0, 6)}`,
      integrations_json: JSON.stringify(input.integrations ?? []),
      created_at: now,
      updated_at: now,
    };
    mkdirSync(workspaceFor(row), { recursive: true });
    db.prepare(
      "INSERT INTO projects (id,name,description,instructions,color,dir,integrations_json,created_at,updated_at) VALUES (@id,@name,@description,@instructions,@color,@dir,@integrations_json,@created_at,@updated_at)",
    ).run({ ...row });
    return row;
  },
  update(id: string, patch: { name?: string; description?: string; instructions?: string; color?: string; integrations?: string[] }) {
    const cur = projects.get(id);
    if (!cur) return;
    const next: ProjectRow = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.integrations !== undefined ? { integrations_json: JSON.stringify(patch.integrations) } : {}),
      updated_at: Date.now(),
    };
    db.prepare(
      "UPDATE projects SET name=@name, description=@description, instructions=@instructions, color=@color, integrations_json=@integrations_json, updated_at=@updated_at WHERE id=@id",
    ).run({ id, name: next.name, description: next.description, instructions: next.instructions, color: next.color, integrations_json: next.integrations_json, updated_at: next.updated_at });
    return next;
  },
  /** Chats move to "no project"; the workspace folder is kept on disk. */
  delete(id: string) {
    db.prepare("UPDATE sessions SET project_id = NULL WHERE project_id = ?").run(id);
    db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  },
  integrations(p?: ProjectRow | null): string[] {
    try {
      return p ? (JSON.parse(p.integrations_json) as string[]) : [];
    } catch {
      return [];
    }
  },
};

export interface SessionRow {
  id: string;
  title: string;
  engine: EngineId;
  model: string;
  engine_session_id: string | null;
  project_id: string | null;
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
    return db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as unknown as SessionRow[];
  },
  get(id: string): SessionRow | undefined {
    return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRow | undefined;
  },
  create(input: { title?: string; engine: EngineId; model: string; projectId?: string | null }): SessionRow {
    const now = Date.now();
    const row: SessionRow = {
      id: randomUUID(),
      title: input.title ?? "New chat",
      engine: input.engine,
      model: input.model,
      engine_session_id: null,
      project_id: input.projectId ?? null,
      created_at: now,
      updated_at: now,
    };
    db.prepare(
      "INSERT INTO sessions (id,title,engine,model,engine_session_id,project_id,created_at,updated_at) VALUES (@id,@title,@engine,@model,@engine_session_id,@project_id,@created_at,@updated_at)",
    ).run({ ...row });
    return row;
  },
  update(id: string, patch: Partial<Pick<SessionRow, "title" | "model" | "engine_session_id" | "project_id">>) {
    const cur = sessions.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updated_at: Date.now() };
    db.prepare(
      "UPDATE sessions SET title=@title, model=@model, engine_session_id=@engine_session_id, project_id=@project_id, updated_at=@updated_at WHERE id=@id",
    ).run({ id: next.id, title: next.title, model: next.model, engine_session_id: next.engine_session_id, project_id: next.project_id ?? null, updated_at: next.updated_at });
    return next;
  },
  delete(id: string) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  },
};

/** running = a pump is driving it; interrupted = the server restarted while it ran. */
export type TurnStatus = "running" | "done" | "error" | "aborted" | "interrupted";

export interface TurnRow {
  id: string;
  session_id: string;
  status: TurnStatus;
  model: string;
  started_at: number;
  ended_at: number | null;
}

export const turns = {
  get(id: string): TurnRow | undefined {
    return db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRow | undefined;
  },
  /** Most recent turn of a session, whatever its status. */
  latest(sessionId: string): TurnRow | undefined {
    return db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(sessionId) as unknown as TurnRow | undefined;
  },
  create(input: { sessionId: string; model: string }): TurnRow {
    const row: TurnRow = {
      id: randomUUID(),
      session_id: input.sessionId,
      status: "running",
      model: input.model,
      started_at: Date.now(),
      ended_at: null,
    };
    db.prepare("INSERT INTO turns (id,session_id,status,model,started_at,ended_at) VALUES (@id,@session_id,@status,@model,@started_at,@ended_at)").run({ ...row });
    return row;
  },
  finish(id: string, status: TurnStatus) {
    db.prepare("UPDATE turns SET status = ?, ended_at = ? WHERE id = ?").run(status, Date.now(), id);
  },
  /** A turn left "running" by a restart can never resume: mark it so clients stop waiting. */
  markStaleInterrupted() {
    const { changes } = db.prepare("UPDATE turns SET status = 'interrupted', ended_at = ? WHERE status = 'running'").run(Date.now());
    return Number(changes ?? 0);
  },
  /** Drop event logs (and rows) for turns that ended before `before`. History stays in `messages`. */
  trim(before: number) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM turn_events WHERE turn_id IN (SELECT id FROM turns WHERE ended_at IS NOT NULL AND ended_at < ?)").run(before);
      const { changes } = db.prepare("DELETE FROM turns WHERE ended_at IS NOT NULL AND ended_at < ?").run(before);
      db.exec("COMMIT");
      return Number(changes ?? 0);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
};

export interface TurnEventRow {
  seq: number;
  type: string;
  json: string;
  created_at: number;
}

export const turnEvents = {
  /** One transaction per batch: in DELETE journal mode every commit costs an fsync. */
  append(turnId: string, rows: Array<{ seq: number; type: string; json: string; created_at: number }>) {
    if (!rows.length) return;
    const stmt = db.prepare("INSERT OR REPLACE INTO turn_events (turn_id,seq,type,json,created_at) VALUES (?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      for (const r of rows) stmt.run(turnId, r.seq, r.type, r.json, r.created_at);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
  /** Events after `from` (a sequence number the client already has), oldest first. */
  since(turnId: string, from = 0, upTo?: number): TurnEventRow[] {
    return (
      upTo === undefined
        ? db.prepare("SELECT seq,type,json,created_at FROM turn_events WHERE turn_id = ? AND seq > ? ORDER BY seq").all(turnId, from)
        : db.prepare("SELECT seq,type,json,created_at FROM turn_events WHERE turn_id = ? AND seq > ? AND seq <= ? ORDER BY seq").all(turnId, from, upTo)
    ) as unknown as TurnEventRow[];
  },
};

export const messages = {
  list(sessionId: string): MessageRow[] {
    return db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as unknown as MessageRow[];
  },
  add(m: Omit<MessageRow, "id" | "created_at">): MessageRow {
    const row: MessageRow = { ...m, id: randomUUID(), created_at: Date.now() };
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,model,tools_json,usage_json,created_at) VALUES (@id,@session_id,@role,@content,@model,@tools_json,@usage_json,@created_at)",
    ).run({ ...row });
    return row;
  },
};
