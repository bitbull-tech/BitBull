/**
 * QA Hound when the connection drops: a stage is tried again once the connection is back, a run
 * that still fails says why and can be picked up again (same models or others) without paying for
 * the reviews twice, and all of it survives a restart.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-recover-"));
process.env.APP_TOKEN = "test-token";

const { paths } = await import("./config.js");
const { db, messages, sessions } = await import("./db.js");
const { engines } = await import("./agent.js");
const { isTransientFailure } = await import("./engines/types.js");
const W = await import("./swarm.js");

const DROP = "Cannot connect to API: The socket connection was closed unexpectedly.";
const REPORT = (n: number) => `## Summary\nok\n\n## Findings\n\n| severity | area | location | what | evidence | fix |\n|---|---|---|---|---|---|\n| high | plan | roadmap.md:3 | gap ${n} | quoted | fix |\n\nRECOMMENDATION: fix-first`;
const VERDICT = 'All weighed.\n\n```qa-hound\n{"verdict":"fix-first","findings":[]}\n```';

/** What each model call does, in order of arrival, by model. */
const calls: Array<{ model: string; kind: "review" | "challenge" | "verdict"; again: boolean }> = [];
let script: (c: { model: string; kind: "review" | "challenge" | "verdict"; nth: number }) => { fail?: string; text?: string } = () => ({ text: "ok" });
for (const id of ["opencode", "claude"] as const)
  engines[id] = {
    id,
    label: "Scripted",
    async *run(input) {
      const kind = /^Challenge round|\n\nChallenge round/.test(input.prompt) || input.prompt.includes("Challenge round.") ? "challenge" : input.prompt.includes("A QA Hound review just finished") ? "verdict" : "review";
      const nth = calls.filter((c) => c.model === input.model && c.kind === kind).length;
      calls.push({ model: input.model, kind, again: input.prompt.includes("The connection dropped before") });
      const r = script({ model: input.model, kind, nth });
      if (r.fail) {
        // as the engine does: retry notices while it is trying, then the real error when it gives up
        yield { type: "error", transient: true, message: `The model call didn't get through (attempt 1 of 7); trying again: ${r.fail}` };
        yield { type: "error", message: `The model call failed 7 times and BitBull stopped trying: ${r.fail}` };
      } else yield { type: "text", delta: r.text ?? "" };
      yield { type: "done", engineSessionId: "scripted", usage: { costUsd: 0.01 } };
    },
  };

mkdirSync(path.join(paths.workspace, "uploads"), { recursive: true });
writeFileSync(path.join(paths.workspace, "uploads", "roadmap.md"), "# Roadmap\n\n- Q1: ship\n");
const finished = async (id: string) => {
  for (let i = 0; i < 400; i++) {
    const s = W.getSwarm(id)!;
    if ((s.phase === "done" || s.phase === "error") && s.finishedAt) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the run did not end");
};
const start = () => {
  const chat = sessions.create({ title: "New chat", engine: "opencode", model: "judge-1" });
  return W.startSwarm({ sessionId: chat.id, target: "uploads/roadmap.md", models: ["m-a", "m-b"], options: { budgetUsd: 5 } });
};

test("what counts as the connection, and what does not", () => {
  assert.equal(isTransientFailure(DROP), true);
  assert.equal(isTransientFailure("fetch failed"), true);
  assert.equal(isTransientFailure("SayGM 429 model_cooling"), true);
  assert.equal(isTransientFailure("SayGM rejected the API key (401)."), false);
  assert.equal(isTransientFailure("The model produced no findings block"), false);
  assert.equal(W.causeOf({}, DROP), "network");
  assert.equal(W.causeOf({}, "SayGM doesn't know the model x (404)."), "model");
  assert.equal(W.causeOf({ stopped: "the $2.00 budget ran out during the verdict" }, "x"), "budget");
  assert.equal(W.causeOf({ stopAsked: true }, DROP), "stopped");
});

test("a reviewer whose connection drops is tried again once the connection is back, and the run finishes", async () => {
  calls.length = 0;
  let up = 0;
  W._setSwarmNet(async () => ++up >= 2); // down at the first look, back at the second
  script = ({ model, kind, nth }) => (kind === "verdict" ? { text: VERDICT } : model === "m-a" && kind === "review" && nth === 0 ? { fail: DROP } : { text: REPORT(nth) });
  const s = await finished(start().id);
  assert.equal(s.phase, "done", s.error ?? "");
  assert.equal(s.verdict, "fix-first");
  const a = calls.filter((c) => c.model === "m-a" && c.kind === "review");
  assert.equal(a.length, 2);
  assert.equal(a[1].again, true); // told the connection dropped, and given the brief again
  assert.equal(calls.filter((c) => c.model === "m-b" && c.kind === "review").length, 1); // the other one is not run twice
  assert.ok(s.log.some((l) => l.level === "warn" && /m-a lost its connection during the review/.test(l.text)));
  assert.ok(s.log.some((l) => /connection is back/.test(l.text)));
  assert.ok(s.log.some((l) => /Verdict written: fix-first/.test(l.text)));
});

test("a verdict that keeps failing ends the run with the reason, in the log and in the chat; it can be picked up", async () => {
  calls.length = 0;
  W._setSwarmNet(async () => true);
  script = ({ kind, nth }) => (kind === "verdict" ? { fail: DROP } : { text: REPORT(nth) });
  const s = await finished(start().id);
  assert.equal(s.phase, "error");
  assert.equal(s.cause, "network");
  assert.match(s.error ?? "", /verdict was not finished.*socket connection was closed/i);
  assert.equal(calls.filter((c) => c.kind === "verdict").length, 1 + W.STAGE_RETRIES);
  assert.equal(W.resumable(s), true);
  const pub = W.publicSwarm(s);
  assert.equal(pub.resumable, true);
  assert.match(pub.advice ?? "", /pick up again/i);
  const said = messages.list(s.sessionId).filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
  assert.match(said, /QA Hound's verdict was not finished/);
  assert.match(said, /Pick up again/);

  // picked up with another model for the verdict: the reviews and the challenge round are not run again
  calls.length = 0;
  script = ({ kind }) => (kind === "verdict" ? { text: VERDICT } : { text: "should not be asked" });
  const next = W.resumeSwarm(s.id, { primaryModel: "judge-2" });
  assert.equal(next.resumedFrom, s.id);
  assert.ok(next.reviewers.every((r) => r.kept && r.sessionId === s.reviewers.find((x) => x.model === r.model)!.sessionId));
  const done = await finished(next.id);
  assert.equal(done.phase, "done", done.error ?? "");
  assert.deepEqual(calls.map((c) => `${c.model}:${c.kind}`), ["judge-2:verdict"]);
  assert.ok(done.log[0].text.includes("Kept: the reports from m-a and m-b, and the challenge round"));
  assert.equal(W.resumable(W.getSwarm(s.id)!), false); // the old one has been picked up
  assert.throws(() => W.resumeSwarm(s.id), /already been picked up/);
});

test("picking up with a different reviewer: that seat runs again, the other keeps its report, and they challenge afresh", async () => {
  calls.length = 0;
  W._setSwarmNet(async () => false); // never comes back
  script = ({ model, kind, nth }) => (model === "m-b" && kind === "review" ? { fail: DROP } : kind === "verdict" ? { text: VERDICT } : { text: REPORT(nth) });
  const s = await finished(start().id);
  // one reviewer down is not the end: the other's report still gets a verdict
  assert.equal(s.reviewers.find((r) => r.model === "m-b")!.status, "error");
  assert.ok(s.log.some((l) => l.level === "error" && /Still no connection/.test(l.text)));
  assert.equal(calls.filter((c) => c.model === "m-b").length, 1); // not hammered while the network is down

  // make it fail outright so it can be picked up: both down
  calls.length = 0;
  script = () => ({ fail: DROP });
  const dead = await finished(start().id);
  assert.equal(dead.phase, "error");
  assert.equal(dead.cause, "network");
  assert.match(dead.error ?? "", /every reviewer failed/);

  calls.length = 0;
  W._setSwarmNet(async () => true);
  script = ({ kind, nth }) => (kind === "verdict" ? { text: VERDICT } : { text: REPORT(nth) });
  const next = W.resumeSwarm(dead.id, { models: ["m-a", "m-c"] });
  assert.deepEqual(next.reviewers.map((r) => r.model), ["m-a", "m-c"]);
  const done = await finished(next.id);
  assert.equal(done.phase, "done", done.error ?? "");
  assert.equal(calls.filter((c) => c.kind === "review").length, 2);
  assert.equal(calls.filter((c) => c.kind === "challenge").length, 2);
  assert.throws(() => W.resumeSwarm(done.id), /nothing to pick up/);
  assert.throws(() => W.resumeSwarm("nope"), /isn't on record/);
});

test("runs are kept across a restart; one that was running is marked as cut off and can be picked up", async () => {
  W._setSwarmNet(async () => true);
  script = ({ kind, nth }) => (kind === "verdict" ? { text: VERDICT } : { text: REPORT(nth) });
  const s = await finished(start().id);
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`hound_run:${s.id}`) as { value: string };
  const saved = JSON.parse(row.value) as { phase: string; reviewers: Array<{ report?: string }>; log: unknown[] };
  assert.equal(saved.phase, "done");
  assert.ok(saved.reviewers.every((r) => r.report)); // the reports themselves, so nothing has to be paid for twice
  // as if BitBull had stopped during the verdict
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...saved, id: "cut-off", phase: "final" }), `hound_run:${s.id}`);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("hound_run:cut-off", JSON.stringify({ ...saved, id: "cut-off", sessionId: s.sessionId, phase: "final", verdict: undefined }));
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("hound_run:junk", "not json");
  assert.ok(W.loadRuns() >= 1);
  const back = W.getSwarm("cut-off")!;
  assert.equal(back.phase, "error");
  assert.equal(back.cause, "restart");
  assert.equal(W.resumable(back), true);
  assert.equal(db.prepare("SELECT 1 FROM meta WHERE key = 'hound_run:junk'").get(), undefined);
  calls.length = 0;
  const done = await finished(W.resumeSwarm("cut-off").id);
  assert.equal(done.phase, "done", done.error ?? "");
  assert.deepEqual(calls.map((c) => c.kind), ["verdict"]);
});
