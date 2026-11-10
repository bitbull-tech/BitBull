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
-- Files mirrored to Hippius. The bytes live there, this is the local ledger, and a Ditto
-- memory per file is the searchable index. project_name is kept so a restore still reads
-- sensibly after a project is renamed or deleted.
CREATE TABLE IF NOT EXISTS stored_files (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  project_name TEXT,
  rel_path TEXT NOT NULL,
  key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  stored_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stored_files_key ON stored_files(key);
CREATE INDEX IF NOT EXISTS idx_stored_files_loc ON stored_files(project_id, rel_path);
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
const pcols = (db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name);
if (!pcols.includes("ditto_sync")) db.exec("ALTER TABLE projects ADD COLUMN ditto_sync INTEGER NOT NULL DEFAULT 0");
if (!pcols.includes("ditto_synced_at")) db.exec("ALTER TABLE projects ADD COLUMN ditto_synced_at INTEGER");
// Archive: set = moved to the sidebar's Archive section (nothing is deleted; NULL = in use)
if (!pcols.includes("archived_at")) db.exec("ALTER TABLE projects ADD COLUMN archived_at INTEGER");
// Response speed: when the first word of a reply arrived (time to first token, per model in the picker)
const tcols = (db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map((c) => c.name);
if (!tcols.includes("first_token_at")) db.exec("ALTER TABLE turns ADD COLUMN first_token_at INTEGER");
if (!cols.includes("archived_at")) db.exec("ALTER TABLE sessions ADD COLUMN archived_at INTEGER");

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
  /** 1 = keep Ditto current for this project (seed from uploads, agent told to save durable facts) */
  ditto_sync: number;
  /** last time a seed/sync run was started */
  ditto_synced_at: number | null;
  /** when it was archived; null = in use */
  archived_at?: number | null;
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
      ditto_sync: 0,
      ditto_synced_at: null,
      created_at: now,
      updated_at: now,
    };
    mkdirSync(workspaceFor(row), { recursive: true });
    db.prepare(
      "INSERT INTO projects (id,name,description,instructions,color,dir,integrations_json,ditto_sync,ditto_synced_at,created_at,updated_at) VALUES (@id,@name,@description,@instructions,@color,@dir,@integrations_json,@ditto_sync,@ditto_synced_at,@created_at,@updated_at)",
    ).run({ ...row });
    return row;
  },
  /** Into the Archive (true) or back out. Doesn't touch updated_at, so it keeps its place. */
  setArchived(id: string, archived: boolean) {
    db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(archived ? Date.now() : null, id);
    return projects.get(id);
  },
  update(id: string, patch: { name?: string; description?: string; instructions?: string; color?: string; integrations?: string[]; dittoSync?: boolean; dittoSyncedAt?: number }) {
    const cur = projects.get(id);
    if (!cur) return;
    const next: ProjectRow = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.integrations !== undefined ? { integrations_json: JSON.stringify(patch.integrations) } : {}),
      ...(patch.dittoSync !== undefined ? { ditto_sync: patch.dittoSync ? 1 : 0 } : {}),
      ...(patch.dittoSyncedAt !== undefined ? { ditto_synced_at: patch.dittoSyncedAt } : {}),
      updated_at: Date.now(),
    };
    db.prepare(
      "UPDATE projects SET name=@name, description=@description, instructions=@instructions, color=@color, integrations_json=@integrations_json, ditto_sync=@ditto_sync, ditto_synced_at=@ditto_synced_at, updated_at=@updated_at WHERE id=@id",
    ).run({ id, name: next.name, description: next.description, instructions: next.instructions, color: next.color, integrations_json: next.integrations_json, ditto_sync: next.ditto_sync, ditto_synced_at: next.ditto_synced_at, updated_at: next.updated_at });
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
  /** when it was archived; null = in use */
  archived_at?: number | null;
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
  /** Into the Archive (true) or back out. Doesn't touch updated_at, so it keeps its place. */
  setArchived(id: string, archived: boolean) {
    db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(archived ? Date.now() : null, id);
    return sessions.get(id);
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
  /** Insert a session with a chosen id and timestamps (imports). Returns false if the id exists. */
  importRow(row: SessionRow): boolean {
    if (sessions.get(row.id)) return false;
    db.prepare(
      "INSERT INTO sessions (id,title,engine,model,engine_session_id,project_id,created_at,updated_at) VALUES (@id,@title,@engine,@model,@engine_session_id,@project_id,@created_at,@updated_at)",
    ).run({ ...row });
    return true;
  },
};

export interface StoredFileRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  /** Path inside the workspace, e.g. "uploads/3f2a/photo.jpg" */
  rel_path: string;
  /** Object key in the Hippius bucket, e.g. "squadron-202-a1b2/uploads/3f2a/photo.jpg" */
  key: string;
  /** Plaintext size in bytes */
  size: number;
  /** SHA-256 of the plaintext, known once it has been read for upload */
  sha256: string | null;
  status: "pending" | "stored" | "failed";
  error: string | null;
  created_at: number;
  stored_at: number | null;
}

export const storedFiles = {
  get(id: string): StoredFileRow | undefined {
    return db.prepare("SELECT * FROM stored_files WHERE id = ?").get(id) as unknown as StoredFileRow | undefined;
  },
  byKey(key: string): StoredFileRow | undefined {
    return db.prepare("SELECT * FROM stored_files WHERE key = ?").get(key) as unknown as StoredFileRow | undefined;
  },
  /** Everything mirrored for a project ("general" = the unfiled workspace), newest first. */
  list(projectId: string | null, limit = 500): StoredFileRow[] {
    return (
      projectId === null
        ? db.prepare("SELECT * FROM stored_files WHERE project_id IS NULL ORDER BY created_at DESC LIMIT ?").all(limit)
        : db.prepare("SELECT * FROM stored_files WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit)
    ) as unknown as StoredFileRow[];
  },
  pending(): StoredFileRow[] {
    return db.prepare("SELECT * FROM stored_files WHERE status = 'pending' ORDER BY created_at").all() as unknown as StoredFileRow[];
  },
  failed(): StoredFileRow[] {
    return db.prepare("SELECT * FROM stored_files WHERE status = 'failed' ORDER BY created_at").all() as unknown as StoredFileRow[];
  },
  counts(): { stored: number; pending: number; failed: number; bytes: number } {
    const rows = db.prepare("SELECT status, COUNT(*) n, COALESCE(SUM(size),0) bytes FROM stored_files GROUP BY status").all() as unknown as Array<{
      status: string;
      n: number;
      bytes: number;
    }>;
    const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return {
      stored: by("stored"),
      pending: by("pending"),
      failed: by("failed"),
      bytes: rows.find((r) => r.status === "stored")?.bytes ?? 0,
    };
  },
  /** One row per key: re-uploading the same path replaces the previous record. */
  add(row: StoredFileRow): StoredFileRow {
    db.prepare(
      `INSERT INTO stored_files (id,project_id,project_name,rel_path,key,size,sha256,status,error,created_at,stored_at)
       VALUES (@id,@project_id,@project_name,@rel_path,@key,@size,@sha256,@status,@error,@created_at,@stored_at)
       ON CONFLICT(key) DO UPDATE SET
         id=excluded.id, project_id=excluded.project_id, project_name=excluded.project_name, size=excluded.size,
         sha256=excluded.sha256, status=excluded.status, error=excluded.error, created_at=excluded.created_at,
         stored_at=excluded.stored_at`,
    ).run({ ...row });
    return row;
  },
  update(id: string, patch: Partial<Pick<StoredFileRow, "status" | "sha256" | "error" | "stored_at">>) {
    const cur = storedFiles.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    db.prepare("UPDATE stored_files SET status=@status, sha256=@sha256, error=@error, stored_at=@stored_at WHERE id=@id").run({
      id,
      status: next.status,
      sha256: next.sha256,
      error: next.error,
      stored_at: next.stored_at,
    });
    return next;
  },
  remove(id: string) {
    db.prepare("DELETE FROM stored_files WHERE id = ?").run(id);
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
  /** when the first text or thinking arrived */
  first_token_at?: number | null;
}

export const turns = {
  get(id: string): TurnRow | undefined {
    return db.prepare("SELECT * FROM turns WHERE id = ?").get(id) as unknown as TurnRow | undefined;
  },
  /** A chat's turns, oldest first (what "files from this reply" is measured against). */
  forSession(sessionId: string): TurnRow[] {
    return db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY started_at").all(sessionId) as unknown as TurnRow[];
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
  firstToken(id: string, at: number) {
    db.prepare("UPDATE turns SET first_token_at = ? WHERE id = ? AND first_token_at IS NULL").run(at, id);
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
  /** Insert a message with its original timestamp (imports). */
  importRow(row: MessageRow) {
    db.prepare(
      "INSERT INTO messages (id,session_id,role,content,model,tools_json,usage_json,created_at) VALUES (@id,@session_id,@role,@content,@model,@tools_json,@usage_json,@created_at)",
    ).run({ ...row });
  },
};
