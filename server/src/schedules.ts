/**
 * Schedules: a prompt BitBull runs on its own at set times, like a routine. Each schedule is a
 * dedicated agent with its own chat, where every run lands, so its history and memory carry
 * from run to run and you can read (or reply to) any run like any other chat. In a project, it
 * runs with that project's workspace, instructions and TEAM.md.
 *
 * Nobody is watching a scheduled run, so it is told so: it prepares anything that publishes,
 * sends, deletes, spends or can't be undone, and leaves it for the owner (see RUN_RULES).
 *
 * Times are wall-clock times in the owner's timezone (the browser's, saved with the schedule),
 * so "every day at 08:00" stays at 08:00 across daylight-saving changes. A run that came due
 * while BitBull was off runs once when it starts again, not once per missed time.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config, type EngineId } from "./config.js";
import { db, projects, sessions, turns } from "./db.js";
import { record } from "./activity.js";
import { notifyOwner, replyText } from "./telegram.js";
import { activeTurnId, collectTurn, startTurn } from "./turns.js";

db.exec(`
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  session_id TEXT,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_turn_id TEXT,
  last_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

if (!(db.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).some((c) => c.name === "notify")) {
  db.exec("ALTER TABLE schedules ADD COLUMN notify TEXT NOT NULL DEFAULT ''");
}

/** When it runs: every N minutes, or at a time of day on chosen weekdays (0 = Sunday). */
export const SpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().min(15).max(7 * 24 * 60) }),
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    tz: z.string().min(1).max(64),
  }),
]);
export type Spec = z.infer<typeof SpecSchema>;

export const ScheduleInput = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(8000),
  projectId: z.string().nullable().optional(),
  engine: z.enum(["opencode", "claude"]).optional(),
  model: z.string().min(1).max(200).optional(),
  spec: SpecSchema,
  enabled: z.boolean().optional(),
  /** send each run's result to the owner's paired Telegram account */
  telegram: z.boolean().optional(),
});
export type ScheduleInput = z.infer<typeof ScheduleInput>;

interface Row {
  id: string;
  name: string;
  prompt: string;
  project_id: string | null;
  engine: string;
  model: string;
  spec_json: string;
  enabled: number;
  session_id: string | null;
  next_run_at: number | null;
  last_run_at: number | null;
  last_turn_id: string | null;
  last_note: string | null;
  notify: string;
  created_at: number;
  updated_at: number;
}

export const MAX_SCHEDULES = 50;

// ---------- when is the next run ----------

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  return f;
}
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function validTimezone(tz: string) {
  try {
    wallClock(tz);
    return true;
  } catch {
    return false;
  }
}

/** The first run strictly after `after` (ms). Daily specs: the next minute whose wall-clock time in tz matches. */
export function nextRun(spec: Spec, after: number): number {
  if (spec.kind === "interval") return after + spec.everyMinutes * 60_000;
  const f = wallClock(spec.tz);
  const [hh, mm] = spec.time.split(":");
  const days = new Set(spec.days);
  // whole minutes only; at most eight days ahead (any weekday and any DST shift fits in that)
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 8 * 24 * 60; i++, t += 60_000) {
    const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
    if (p.minute === mm && p.hour === hh && days.has(WEEKDAY[p.weekday])) return t;
  }
  // a time that doesn't exist in this zone (skipped by DST every day of the week): try a day later
  return after + 24 * 60 * 60_000;
}

/** "Every 2 hours", "Weekdays at 08:00", "Mon, Thu at 18:30". */
export function describe(spec: Spec): string {
  if (spec.kind === "interval") {
    const m = spec.everyMinutes;
    return m % 1440 === 0 ? `Every ${m / 1440 === 1 ? "day" : `${m / 1440} days`}` : m % 60 === 0 ? `Every ${m / 60 === 1 ? "hour" : `${m / 60} hours`}` : `Every ${m} minutes`;
  }
  const d = [...new Set(spec.days)].sort();
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const when = d.length === 7 ? "Every day" : d.join() === "1,2,3,4,5" ? "Weekdays" : d.join() === "0,6" ? "Weekends" : d.map((x) => names[x]).join(", ");
  return `${when} at ${spec.time}`;
}

// ---------- storage ----------

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  projectId: string | null;
  projectName?: string;
  engine: EngineId;
  model: string;
  spec: Spec;
  when: string;
  enabled: boolean;
  /** each run's result also goes to the owner's Telegram */
  telegram: boolean;
  sessionId: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** the last run's turn status (running, done, error, …), or why it didn't run */
  lastStatus: string | null;
  lastNote: string | null;
}

function toSchedule(r: Row): Schedule {
  const spec = SpecSchema.parse(JSON.parse(r.spec_json));
  const turn = r.last_turn_id ? turns.get(r.last_turn_id) : undefined;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    projectId: r.project_id,
    projectName: r.project_id ? projects.get(r.project_id)?.name : undefined,
    engine: r.engine as EngineId,
    model: r.model,
    spec,
    when: describe(spec),
    enabled: !!r.enabled,
    telegram: r.notify === "telegram",
    sessionId: r.session_id && sessions.get(r.session_id) ? r.session_id : null,
    nextRunAt: r.enabled ? r.next_run_at : null,
    lastRunAt: r.last_run_at,
    lastStatus: turn?.status ?? (r.last_note ? "skipped" : null),
    lastNote: r.last_note,
  };
}

const getRow = (id: string) => db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as unknown as Row | undefined;

export const schedules = {
  list(): Schedule[] {
    return (db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as unknown as Row[]).map(toSchedule);
  },
  get(id: string): Schedule | undefined {
    const r = getRow(id);
    return r ? toSchedule(r) : undefined;
  },
  create(input: ScheduleInput, now = Date.now()): Schedule {
    if ((db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number }).n >= MAX_SCHEDULES) throw new Error(`At most ${MAX_SCHEDULES} schedules`);
    const clean = check(input);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO schedules (id,name,prompt,project_id,engine,model,spec_json,enabled,notify,next_run_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, clean.name, clean.prompt, clean.projectId, clean.engine, clean.model, JSON.stringify(clean.spec), clean.enabled ? 1 : 0, clean.telegram ? "telegram" : "", nextRun(clean.spec, now), now, now);
    return schedules.get(id)!;
  },
  update(id: string, input: Partial<ScheduleInput>, now = Date.now()): Schedule | undefined {
    const cur = schedules.get(id);
    if (!cur) return undefined;
    const clean = check({ name: cur.name, prompt: cur.prompt, projectId: cur.projectId, engine: cur.engine, model: cur.model, spec: cur.spec, enabled: cur.enabled, telegram: cur.telegram, ...input });
    const specChanged = JSON.stringify(clean.spec) !== JSON.stringify(cur.spec) || (clean.enabled && !cur.enabled);
    db.prepare("UPDATE schedules SET name=?, prompt=?, project_id=?, engine=?, model=?, spec_json=?, enabled=?, notify=?, next_run_at=?, updated_at=? WHERE id=?").run(
      clean.name,
      clean.prompt,
      clean.projectId,
      clean.engine,
      clean.model,
      JSON.stringify(clean.spec),
      clean.enabled ? 1 : 0,
      clean.telegram ? "telegram" : "",
      specChanged ? nextRun(clean.spec, now) : getRow(id)!.next_run_at,
      now,
      id,
    );
    // a schedule moved to another project starts a new chat there
    if (clean.projectId !== cur.projectId) db.prepare("UPDATE schedules SET session_id = NULL WHERE id = ?").run(id);
    return schedules.get(id);
  },
  /** The chat keeps everything it ran; only the schedule goes. */
  delete(id: string) {
    db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  },
};

function check(input: ScheduleInput) {
  const v = ScheduleInput.parse(input);
  if (v.spec.kind === "daily" && !validTimezone(v.spec.tz)) throw new Error(`Unknown timezone: ${v.spec.tz}`);
  const projectId = v.projectId && projects.get(v.projectId) ? v.projectId : null;
  if (v.projectId && !projectId) throw new Error("That project doesn't exist");
  return {
    name: v.name,
    prompt: v.prompt,
    projectId,
    engine: (v.engine ?? config.agent.defaultEngine) as EngineId,
    model: v.model ?? config.agent.defaultModel,
    spec: v.spec,
    enabled: v.enabled ?? true,
    telegram: v.telegram ?? false,
  };
}

// ---------- running ----------

/** Said at the top of every scheduled run: nobody is there to approve anything. */
export const RUN_RULES = (name: string, at: Date) =>
  [
    `[Scheduled run of "${name}", ${at.toISOString().slice(0, 16).replace("T", " ")} UTC. Nobody is watching this run.]`,
    "Do the work below. Don't publish, send, post, delete, spend money or make any change that can't be undone: prepare it and list it under **Waiting for your approval** at the end, so the owner can approve it in this chat. If the workspace has a TEAM.md, run the work as that team. Earlier runs are above in this chat: build on them rather than repeating them. Finish with a short summary of what you did and found.",
    "",
  ].join("\n");

/** Start one run now (also "Run now"). Returns the turn id, or why it didn't start. */
export function runSchedule(id: string, now = Date.now()): { turnId?: string; skipped?: string } {
  const r = getRow(id);
  if (!r) return { skipped: "No such schedule" };
  const s = toSchedule(r);
  let session = s.sessionId ? sessions.get(s.sessionId) : undefined;
  if (session && activeTurnId(session.id)) {
    const note = "Skipped: the previous run was still going";
    db.prepare("UPDATE schedules SET last_note = ? WHERE id = ?").run(note, id);
    record({ level: "warn", source: "schedule", message: `${s.name}: ${note.toLowerCase()}`, sessionId: session.id, sessionTitle: session.title });
    return { skipped: note };
  }
  if (!session) {
    session = sessions.create({ title: `⏰ ${s.name}`, engine: s.engine, model: s.model, projectId: s.projectId });
    db.prepare("UPDATE schedules SET session_id = ? WHERE id = ?").run(session.id, id);
  }
  const { turnId } = startTurn(session, { prompt: RUN_RULES(s.name, new Date(now)) + s.prompt, model: s.model });
  db.prepare("UPDATE schedules SET last_run_at = ?, last_turn_id = ?, last_note = NULL WHERE id = ?").run(now, turnId, id);
  record({ level: "info", source: "schedule", message: `Scheduled run started: ${s.name}`, sessionId: session.id, sessionTitle: session.title });
  // the result goes to the owner's phone when they asked for that; a run nobody is paired for just stays in its chat
  if (s.telegram) {
    void collectTurn(turnId)
      .then(({ events, status }) => notifyOwner(`⏰ ${s.name}\n\n${replyText(events, status)}`))
      .catch(() => {});
  }
  return { turnId };
}

/** Run everything due, and set each one's next time. */
export function tick(now = Date.now()) {
  const due = db.prepare("SELECT id, spec_json FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?").all(now) as unknown as Array<Pick<Row, "id" | "spec_json">>;
  for (const d of due) {
    // the next time first, so a run that fails to start can't fire again on every tick
    db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(nextRun(SpecSchema.parse(JSON.parse(d.spec_json)), now), d.id);
    try {
      runSchedule(d.id, now);
    } catch (e) {
      const note = `Couldn't start: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      db.prepare("UPDATE schedules SET last_note = ? WHERE id = ?").run(note, d.id);
      record({ level: "error", source: "schedule", message: note });
    }
  }
  return due.length;
}

export function startScheduler() {
  setInterval(() => tick(), 30_000).unref();
  setTimeout(() => tick(), 10_000).unref();
}
