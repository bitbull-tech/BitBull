/**
 * Schedules: when the next run is (wall-clock time in the owner's zone, across DST), what a run
 * is told, and that a run lands in the schedule's own chat and never doubles up.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-schedules-"));
const { describe, nextRun, RUN_RULES, schedules, SpecSchema, tick } = await import("./schedules.js");
const { db } = await import("./db.js");

const iso = (ms: number) => new Date(ms).toISOString();

test("next run: intervals, and a time of day in the owner's zone", () => {
  const t0 = Date.parse("2026-11-13T10:00:00Z");
  assert.equal(iso(nextRun({ kind: "interval", everyMinutes: 120 }, t0)), "2026-11-13T12:00:00.000Z");
  // 08:00 in London (GMT in November) on weekdays: Friday 13th has passed, so Monday 16th
  const weekdays = { kind: "daily" as const, time: "08:00", days: [1, 2, 3, 4, 5], tz: "Europe/London" };
  assert.equal(iso(nextRun(weekdays, t0)), "2026-11-16T08:00:00.000Z");
  // the same in New York (EST, UTC-5): Friday 08:00 local is 13:00 UTC, still to come
  assert.equal(iso(nextRun({ ...weekdays, tz: "America/New_York" }, t0)), "2026-11-13T13:00:00.000Z");
  // strictly after: at exactly the time, the next one is a day on
  const daily = { kind: "daily" as const, time: "10:00", days: [0, 1, 2, 3, 4, 5, 6], tz: "UTC" };
  assert.equal(iso(nextRun(daily, t0)), "2026-11-14T10:00:00.000Z");
});

test("wall-clock time holds across a daylight-saving change", () => {
  // London goes to BST on 29 March 2026: 08:00 local is 08:00 UTC on the 28th, 07:00 UTC on the 30th
  const spec = { kind: "daily" as const, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], tz: "Europe/London" };
  const a = nextRun(spec, Date.parse("2026-03-28T07:00:00Z"));
  const b = nextRun(spec, Date.parse("2026-03-29T12:00:00Z"));
  assert.equal(iso(a), "2026-03-28T08:00:00.000Z");
  assert.equal(iso(b), "2026-03-30T07:00:00.000Z");
});

test("specs are checked, and described in plain words", () => {
  assert.throws(() => SpecSchema.parse({ kind: "interval", everyMinutes: 5 }), "at least 15 minutes");
  assert.throws(() => SpecSchema.parse({ kind: "daily", time: "25:00", days: [1], tz: "UTC" }));
  assert.throws(() => SpecSchema.parse({ kind: "daily", time: "08:00", days: [], tz: "UTC" }));
  assert.equal(describe({ kind: "interval", everyMinutes: 120 }), "Every 2 hours");
  assert.equal(describe({ kind: "interval", everyMinutes: 1440 }), "Every day");
  assert.equal(describe({ kind: "daily", time: "08:00", days: [5, 1, 2, 3, 4], tz: "UTC" }), "Weekdays at 08:00");
  assert.equal(describe({ kind: "daily", time: "18:30", days: [1, 4], tz: "UTC" }), "Mon, Thu at 18:30");
  assert.throws(() => schedules.create({ name: "x", prompt: "y", spec: { kind: "daily", time: "08:00", days: [1], tz: "Mars/Olympus" } }), /timezone/);
});

test("a run says nobody is watching and that irreversible steps wait for approval", () => {
  const rules = RUN_RULES("Morning brief", new Date("2026-11-13T08:00:00Z"));
  assert.match(rules, /Nobody is watching/);
  assert.match(rules, /Waiting for your approval/);
  assert.match(rules, /TEAM\.md/);
});

test("due schedules run once in their own chat; a run still going is not doubled", async () => {
  const s = schedules.create({ name: "Brief", prompt: "Say hello", model: "test-model", spec: { kind: "interval", everyMinutes: 60 } }, Date.parse("2026-11-13T08:00:00Z"));
  assert.equal(s.when, "Every hour");
  assert.equal(iso(s.nextRunAt!), "2026-11-13T09:00:00.000Z");
  // not due yet
  assert.equal(tick(Date.parse("2026-11-13T08:30:00Z")), 0);
  // due (and long overdue: one run, not one per missed hour)
  assert.equal(tick(Date.parse("2026-11-13T13:10:00Z")), 1);
  const after = schedules.get(s.id)!;
  assert.ok(after.sessionId, "a chat of its own");
  assert.equal(iso(after.nextRunAt!), "2026-11-13T14:10:00.000Z");
  const chat = db.prepare("SELECT title, project_id FROM sessions WHERE id = ?").get(after.sessionId) as { title: string; project_id: string | null };
  assert.equal(chat.title, "⏰ Brief");
  // the turn is still running (no model here), so the next due time is skipped, not doubled
  assert.equal(tick(Date.parse("2026-11-13T14:11:00Z")), 1);
  const skipped = schedules.get(s.id)!;
  assert.equal(skipped.lastStatus, "running");
  assert.equal(skipped.lastNote, "Skipped: the previous run was still going");
  // turning it off stops it; deleting keeps the chat
  schedules.update(s.id, { enabled: false });
  assert.equal(schedules.get(s.id)!.nextRunAt, null);
  assert.equal(tick(Date.parse("2026-11-14T00:00:00Z")), 0);
  schedules.delete(s.id);
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(after.sessionId!));
});
