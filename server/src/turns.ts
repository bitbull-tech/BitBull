/**
 * Turns that outlive the connection that asked for them.
 *
 * `runTurn()` is an async generator: whoever consumes it drives it. If that consumer is the
 * HTTP response, a client going away (phone locked, laptop asleep, tunnel blip) stalls the
 * turn and there is nothing to re-attach to. So the turn is pumped here instead, into an
 * append-only event log, and HTTP routes become *readers* of that log: they can join late,
 * drop, and re-join from any sequence number, and several clients can watch one turn.
 *
 * Sequence numbers start at 1. "from" always means "the last seq I already have".
 */
import { runTurn, abortRun } from "./agent.js";
import { config } from "./config.js";
import { turnEvents, turns, type SessionRow, type TurnStatus } from "./db.js";
import type { AgentEvent } from "./engines/types.js";
import { record } from "./activity.js";

export type { TurnStatus };
export interface TurnRecord {
  seq: number;
  event: AgentEvent & { messageId?: string };
}

/** Persist at most this often: in DELETE journal mode each commit costs an fsync. */
const FLUSH_MS = 250;
/** Keep a finished turn in memory this long so a quick re-attach doesn't touch the DB. */
const KEEP_FINISHED_MS = 5 * 60_000;
/** Cap memory per turn; older events stay available from the DB. */
const MAX_MEM_EVENTS = 5000;

interface Watcher {
  event(rec: TurnRecord): void;
  end(status: TurnStatus): void;
}

interface LiveTurn {
  id: string;
  sessionId: string;
  status: TurnStatus;
  /** Events held in memory, oldest first. events[0].seq === baseSeq + 1 */
  events: TurnRecord[];
  baseSeq: number;
  lastSeq: number;
  pending: Array<{ seq: number; type: string; json: string; created_at: number }>;
  timer: NodeJS.Timeout | null;
  watchers: Set<Watcher>;
  aborted: boolean;
}

const live = new Map<string, LiveTurn>();
/** sessionId → turnId, for turns that are still running. */
const activeBySession = new Map<string, string>();

export function activeTurnId(sessionId: string) {
  return activeBySession.get(sessionId);
}

/** The turn a client should attach to for this session: the running one, else the last one. */
export function latestTurnId(sessionId: string) {
  return activeBySession.get(sessionId) ?? turns.latest(sessionId)?.id;
}

export function turnStatus(turnId: string): TurnStatus | undefined {
  return live.get(turnId)?.status ?? turns.get(turnId)?.status;
}

function flush(t: LiveTurn) {
  if (t.timer) {
    clearTimeout(t.timer);
    t.timer = null;
  }
  if (!t.pending.length) return;
  const rows = t.pending;
  t.pending = [];
  try {
    turnEvents.append(t.id, rows);
  } catch (e) {
    // Losing the replay log must never lose the turn itself: history is saved by runTurn.
    console.error(`[turns] could not persist ${rows.length} event(s) for ${t.id}:`, e);
  }
}

function emit(t: LiveTurn, event: AgentEvent & { messageId?: string }) {
  const seq = ++t.lastSeq;
  const rec: TurnRecord = { seq, event };
  t.events.push(rec);
  t.pending.push({ seq, type: event.type, json: JSON.stringify(event), created_at: Date.now() });
  if (!t.timer) {
    t.timer = setTimeout(() => flush(t), FLUSH_MS);
    t.timer.unref?.();
  }
  if (t.events.length > MAX_MEM_EVENTS) {
    flush(t); // never drop an event from memory before it is on disk
    const drop = t.events.length - MAX_MEM_EVENTS;
    t.events.splice(0, drop);
    t.baseSeq = t.events[0].seq - 1;
  }
  for (const w of t.watchers) {
    try {
      w.event(rec);
    } catch {
      /* a broken watcher must not stop the turn */
    }
  }
}

function finish(t: LiveTurn, status: TurnStatus) {
  flush(t);
  t.status = status;
  turns.finish(t.id, status);
  if (activeBySession.get(t.sessionId) === t.id) activeBySession.delete(t.sessionId);
  for (const w of t.watchers) {
    try {
      w.end(status);
    } catch {
      /* ignore */
    }
  }
  t.watchers.clear();
  const sweep = setTimeout(() => live.delete(t.id), KEEP_FINISHED_MS);
  sweep.unref?.();
}

/**
 * Start a turn and return immediately. The turn runs to completion whether or not
 * anyone is listening; read it with `snapshot()` + `watch()`.
 */
export function startTurn(
  session: SessionRow,
  input: { prompt: string; model: string; attachments?: string[]; plan?: boolean },
): { turnId: string; status: TurnStatus } {
  const existing = activeBySession.get(session.id);
  if (existing) return { turnId: existing, status: "running" };

  const row = turns.create({ sessionId: session.id, model: input.model });
  const t: LiveTurn = {
    id: row.id,
    sessionId: session.id,
    status: "running",
    events: [],
    baseSeq: 0,
    lastSeq: 0,
    pending: [],
    timer: null,
    watchers: new Set(),
    aborted: false,
  };
  live.set(t.id, t);
  activeBySession.set(session.id, t.id);

  void (async () => {
    let status: TurnStatus = "done";
    try {
      for await (const ev of runTurn(session, input.prompt, input.model, input.attachments ?? [], { plan: input.plan })) {
        if (ev.type === "error") status = "error";
        emit(t, ev);
      }
    } catch (err) {
      // runTurn handles its own errors; this is the belt-and-braces path.
      const message = err instanceof Error ? err.message : String(err);
      status = "error";
      emit(t, { type: "error", message });
      record({ level: "error", source: "agent", sessionId: session.id, message: `Turn crashed: ${message}` });
    } finally {
      finish(t, t.aborted ? "aborted" : status);
      trimOldTurns();
    }
  })();

  return { turnId: t.id, status: "running" };
}

/** Stop the running turn of a session, if any. */
export function abortTurn(sessionId: string) {
  const id = activeBySession.get(sessionId);
  if (id) {
    const t = live.get(id);
    if (t) t.aborted = true;
  }
  abortRun(sessionId);
  return !!id;
}

/**
 * Everything after `from`, from memory where possible and the DB otherwise.
 * Returns undefined for an unknown turn.
 */
export function snapshot(turnId: string, from = 0): { events: TurnRecord[]; status: TurnStatus; lastSeq: number } | undefined {
  const t = live.get(turnId);
  if (t) {
    const fromDb =
      from < t.baseSeq
        ? turnEvents.since(turnId, from, t.baseSeq).map((r) => ({ seq: r.seq, event: JSON.parse(r.json) as TurnRecord["event"] }))
        : [];
    const mem = t.events.filter((r) => r.seq > from);
    return { events: [...fromDb, ...mem], status: t.status, lastSeq: t.lastSeq };
  }
  const row = turns.get(turnId);
  if (!row) return undefined;
  const events = turnEvents.since(turnId, from).map((r) => ({ seq: r.seq, event: JSON.parse(r.json) as TurnRecord["event"] }));
  return { events, status: row.status, lastSeq: events.length ? events[events.length - 1].seq : from };
}

/**
 * Follow a live turn. Subscribe *before* taking a snapshot and skip records you have
 * already sent, otherwise an event emitted between the two is lost.
 * Returns an unsubscribe function; for a turn that is already finished it calls
 * `end()` on the next tick and nothing else.
 */
export function watch(turnId: string, w: Watcher): () => void {
  const t = live.get(turnId);
  if (!t || t.status !== "running") {
    const status = t?.status ?? turns.get(turnId)?.status ?? "done";
    const timer = setTimeout(() => w.end(status), 0);
    return () => clearTimeout(timer);
  }
  t.watchers.add(w);
  return () => t.watchers.delete(w);
}

/**
 * Wait for a turn to finish and return everything it produced. For one-shot callers
 * (`POST /api/v1/chat`); the turn is still logged and re-attachable while it runs.
 */
export function collectTurn(turnId: string): Promise<{ events: TurnRecord[]; status: TurnStatus }> {
  return new Promise((resolve) => {
    watch(turnId, {
      event: () => {},
      // The whole log is readable once it has finished (memory for 5 minutes, then the DB).
      end: (status) => resolve({ events: snapshot(turnId, 0)?.events ?? [], status }),
    });
  });
}

let lastTrim = 0;
/** Housekeeping: event logs are a replay buffer, not history. Runs at most hourly. */
export function trimOldTurns() {
  const days = config.agent.turnRetentionDays;
  if (!(days > 0) || Date.now() - lastTrim < 3600_000) return;
  lastTrim = Date.now();
  try {
    turns.trim(Date.now() - days * 86400_000);
  } catch (e) {
    console.error("[turns] trim failed:", e);
  }
}

/** Called once at startup: nothing can still be running, whatever the DB says. */
export function resetStaleTurns() {
  const n = turns.markStaleInterrupted();
  if (n) console.log(`[turns] ${n} turn(s) were interrupted by a restart`);
  lastTrim = 0;
  trimOldTurns();
}
