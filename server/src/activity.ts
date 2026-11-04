import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Activity feed: one stream of everything the server and agent do (turns, tool calls,
 * uploads, integrations, warnings, errors) for the UI's Activity panel and error alerts.
 * Kept in memory (last MAX events) and appended to <DATA_DIR>/logs/activity.jsonl so it
 * survives restarts. Secrets are redacted before anything is stored.
 */
export type Level = "debug" | "info" | "warn" | "error";
export type Source = "server" | "config" | "saygm" | "agent" | "tool" | "subagent" | "upload" | "ditto" | "opencode" | "claude" | "integration" | "skills" | "storage" | "network" | "swarm";

export interface ActivityEvent {
  id: number;
  ts: string;
  level: Level;
  source: Source;
  message: string;
  /** chat this belongs to, when there is one */
  sessionId?: string;
  sessionTitle?: string;
  /** longer text: tool input/output, stack, raw log line */
  detail?: string;
}

const MAX = 2000;
const dir = path.join(config.dataDir, "logs");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "activity.jsonl");

const secrets = () =>
  [
    config.saygm.apiKey,
    config.ditto.apiKey,
    config.appToken,
    config.integrations.atlas.apiKey,
    config.integrations.four04.apiKey,
    config.integrations.github.token,
    config.integrations.taostats.apiKey,
    config.storage.accessKey,
    config.storage.secretKey,
    config.storage.encryptionKey,
  ].filter((s) => s && s.length > 6);
export const redact = (s: string) => secrets().reduce((acc, k) => acc.split(k).join("[REDACTED]"), s);

const buf: ActivityEvent[] = [];
let nextId = 1;
const subscribers = new Set<(e: ActivityEvent) => void>();

// Load the tail of the previous run
try {
  if (existsSync(file)) {
    const lines = readFileSync(file, "utf8").trim().split("\n").slice(-MAX);
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as ActivityEvent;
        // a line that parses but isn't an event (torn write, edited file) must not break ids
        if (!e || typeof e !== "object" || !Number.isSafeInteger(e.id) || e.id < 0 || typeof e.message !== "string") continue;
        buf.push(e);
        nextId = Math.max(nextId, e.id + 1);
      } catch {
        /* skip a torn line */
      }
    }
  }
} catch {
  /* start empty */
}

function persist(e: ActivityEvent) {
  try {
    if (existsSync(file) && statSync(file).size > 10 * 1024 * 1024) renameSync(file, file + ".1");
    appendFileSync(file, JSON.stringify(e) + "\n");
  } catch {
    /* logging must never break the app */
  }
}

export function record(e: Omit<ActivityEvent, "id" | "ts">): ActivityEvent {
  const ev: ActivityEvent = {
    ...e,
    id: nextId++,
    ts: new Date().toISOString(),
    message: redact(e.message).slice(0, 2000),
    ...(e.detail ? { detail: redact(e.detail).slice(0, 20000) } : {}),
  };
  buf.push(ev);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  if (ev.level !== "debug") persist(ev);
  for (const fn of subscribers) {
    try {
      fn(ev);
    } catch {
      /* a dead subscriber shouldn't affect others */
    }
  }
  return ev;
}

export function recent(opts: { after?: number; level?: Level; sessionId?: string; limit?: number } = {}) {
  const order: Level[] = ["debug", "info", "warn", "error"];
  const min = opts.level ? order.indexOf(opts.level) : 0;
  return buf
    .filter((e) => (opts.after === undefined || e.id > opts.after) && order.indexOf(e.level) >= min && (!opts.sessionId || e.sessionId === opts.sessionId))
    .slice(-(opts.limit ?? 500));
}

export function subscribe(fn: (e: ActivityEvent) => void) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Map a console line's "[tag] message" prefix to a source. */
export function sourceOf(text: string): Source {
  const tag = text.match(/^\[([a-z-]+)\]/i)?.[1]?.toLowerCase();
  const known: Source[] = ["upload", "ditto", "opencode", "claude", "skills", "subagent", "saygm", "config"];
  if (tag && (known as string[]).includes(tag)) return tag as Source;
  if (tag === "subagents") return "subagent";
  if (tag === "projects") return "server";
  return "server";
}
