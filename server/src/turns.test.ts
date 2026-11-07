/**
 * Turns must survive the connection that started them: these tests run a turn with
 * nobody listening, then attach late, mid-turn and after the end.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before config/db are imported: they read the environment at module load.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-turns-"));
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";

const { messages, sessions, turnEvents, turns } = await import("./db.js");
const { engines } = await import("./agent.js");
const { abortTurn, activeTurnId, collectTurn, latestTurnId, snapshot, startTurn, watch } = await import("./turns.js");
type AgentEvent = import("./engines/types.js").AgentEvent;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Replaces the OpenCode engine with a scripted one; `gate` pauses it mid-stream. */
function fakeEngine(events: AgentEvent[], gate?: { promise: Promise<void> }, gateAfter = 0) {
  engines.opencode = {
    id: "opencode",
    label: "Fake",
    async *run() {
      let i = 0;
      for (const ev of events) {
        if (gate && i === gateAfter) await gate.promise;
        i++;
        yield ev;
      }
    },
  };
}

const newSession = () => sessions.create({ engine: "opencode", model: "test-model" });
const text = (events: Array<{ event: AgentEvent }>) =>
  events.map((e) => (e.event.type === "text" ? e.event.delta : "")).join("");

test("a turn runs to completion with nobody listening", async () => {
  fakeEngine([
    { type: "text", delta: "Hello " },
    { type: "text", delta: "world" },
    { type: "done", engineSessionId: "engine-1" },
  ]);
  const s = newSession();
  const { turnId } = startTurn(s, { prompt: "hi", model: "test-model" });
  const { events, status } = await collectTurn(turnId);

  assert.equal(status, "done");
  assert.equal(text(events), "Hello world");
  // The assistant's reply is in history, and the engine session was carried over
  const hist = messages.list(s.id);
  assert.equal(hist.at(-1)?.content, "Hello world");
  assert.equal(sessions.get(s.id)?.engine_session_id, "engine-1");
  // Sequence numbers start at 1 and have no gaps
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
});

test("re-attaching from a sequence number replays only what was missed", async () => {
  fakeEngine([
    { type: "text", delta: "one" },
    { type: "tool_start", id: "t1", name: "bash", input: { command: "ls" } },
    { type: "tool_end", id: "t1", output: "a.txt" },
    { type: "text", delta: "two" },
    { type: "done", engineSessionId: "engine-2" },
  ]);
  const s = newSession();
  const { turnId } = startTurn(s, { prompt: "hi", model: "test-model" });
  const all = (await collectTurn(turnId)).events;
  assert.equal(all.length, 5);

  const missed = snapshot(turnId, 2);
  assert.ok(missed);
  assert.equal(missed.status, "done");
  assert.deepEqual(
    missed.events.map((e) => e.seq),
    [3, 4, 5],
  );
  assert.equal(missed.events[0].event.type, "tool_end");
  // Past the end: nothing to replay, and the client is already up to date
  assert.equal(snapshot(turnId, 5)?.events.length, 0);
});

test("a client that joins mid-turn gets the backlog and then the live events", async () => {
  const gate = deferred();
  fakeEngine(
    [
      { type: "text", delta: "before" },
      { type: "text", delta: "after" },
      { type: "done", engineSessionId: "engine-3" },
    ],
    gate,
    1, // pause after the first event
  );
  const s = newSession();
  const { turnId } = startTurn(s, { prompt: "hi", model: "test-model" });

  // Wait for the first event to be emitted, then attach like a reconnecting client would
  while ((snapshot(turnId, 0)?.events.length ?? 0) === 0) await new Promise((r) => setImmediate(r));
  assert.equal(activeTurnId(s.id), turnId);

  const live: number[] = [];
  const ended = deferred<string>();
  const backlog = snapshot(turnId, 0)!.events.map((e) => e.seq);
  watch(turnId, { event: (rec) => live.push(rec.seq), end: (status) => ended.resolve(status) });

  gate.resolve();
  assert.equal(await ended.promise, "done");
  assert.deepEqual(backlog, [1]);
  assert.deepEqual(live, [2, 3]);
  assert.equal(activeTurnId(s.id), undefined, "the session is free again once the turn ends");
  assert.equal(latestTurnId(s.id), turnId);
});

test("the event log is readable from the database after the turn", async () => {
  fakeEngine([
    { type: "text", delta: "persisted" },
    { type: "done", engineSessionId: "engine-4" },
  ]);
  const s = newSession();
  const { turnId } = startTurn(s, { prompt: "hi", model: "test-model" });
  await collectTurn(turnId);

  const rows = turnEvents.since(turnId, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, "text");
  assert.equal((JSON.parse(rows[0].json) as { delta: string }).delta, "persisted");
  assert.equal(turns.get(turnId)?.status, "done");
  assert.equal(turnEvents.since(turnId, 1).length, 1);
});

test("one turn per session: a second start returns the running one", async () => {
  const gate = deferred();
  fakeEngine([{ type: "text", delta: "busy" }, { type: "done", engineSessionId: "engine-5" }], gate, 0);
  const s = newSession();
  const first = startTurn(s, { prompt: "one", model: "test-model" });
  const second = startTurn(s, { prompt: "two", model: "test-model" });
  assert.equal(second.turnId, first.turnId);
  gate.resolve();
  await collectTurn(first.turnId);
  // The second prompt was never queued as a message
  assert.deepEqual(
    messages.list(s.id).filter((m) => m.role === "user").map((m) => m.content),
    ["one"],
  );
});

test("aborting a turn ends it as aborted", async () => {
  const gate = deferred();
  engines.opencode = {
    id: "opencode",
    label: "Fake",
    async *run({ signal }) {
      yield { type: "text", delta: "working" } as AgentEvent;
      await gate.promise;
      if (signal.aborted) yield { type: "done", engineSessionId: "engine-6" } as AgentEvent;
    },
  };
  const s = newSession();
  const { turnId } = startTurn(s, { prompt: "hi", model: "test-model" });
  while ((snapshot(turnId, 0)?.events.length ?? 0) === 0) await new Promise((r) => setImmediate(r));

  assert.equal(abortTurn(s.id), true);
  gate.resolve();
  const { status } = await collectTurn(turnId);
  assert.equal(status, "aborted");
  assert.equal(turns.get(turnId)?.status, "aborted");
  assert.equal(abortTurn(s.id), false, "nothing left to abort");
});

test("a turn left running by a restart is marked interrupted", () => {
  const s = newSession();
  const row = turns.create({ sessionId: s.id, model: "test-model" });
  assert.equal(turns.get(row.id)?.status, "running");
  assert.ok(turns.markStaleInterrupted() >= 1);
  assert.equal(turns.get(row.id)?.status, "interrupted");
  // watch() on a finished turn reports its status instead of hanging
  return new Promise<void>((resolve) => {
    watch(row.id, {
      event: () => {},
      end: (status) => {
        assert.equal(status, "interrupted");
        resolve();
      },
    });
  });
});
