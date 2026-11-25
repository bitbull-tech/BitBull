/** The cross-examination ledger: numbering, who may say what, when it stops, and what the verdict is told. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-debate-"));
process.env.APP_TOKEN = "test-token";

const D = await import("./houndDebate.js");
const { paths } = await import("./config.js");
const { sessions } = await import("./db.js");
const { engines } = await import("./agent.js");
const W = await import("./swarm.js");

const report = (rows: string[]) => `## Summary\nfine\n\n## Findings\n\n| Severity | Area | Location | What | Evidence | Fix |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n\n## Correctness\n3/5\n\nRECOMMENDATION: fix-first`;
const A = report(["| **High** | plan | roadmap.md:12 | Q2 depends on Q3 | quoted | reorder |", "| low | clarity | roadmap.md:30 | No owner named | quoted | name one |"]);
const B = report(["| medium | risk | roadmap.md:44 | No fallback if the validator slips | quoted | add one |"]);
const block = (o: unknown) => "Prose first.\n\n```qa-hound-debate\n" + JSON.stringify(o) + "\n```\nRECOMMENDATION: fix-first";

test("findings are numbered from each report's own table", () => {
  const p = D.startDebate([A, B]);
  assert.deepEqual(p.map((x) => x.id), ["A1", "A2", "B1"]);
  assert.deepEqual([p[0].severity, p[0].location, p[0].what], ["high", "roadmap.md:12", "Q2 depends on Q3"]);
  assert.equal(p[2].owner, 1);
  assert.deepEqual(D.startDebate(["no table here", undefined]), []);
  // a table whose columns are in another order is read by its headings
  const odd = "## Findings\n| What | Where | Severity |\n|---|---|---|\n| Leaks the key | src/a.ts:3 | critical |\n";
  assert.deepEqual(D.findingsOf(odd), [{ severity: "critical", location: "src/a.ts:3", what: "Leaks the key" }]);
});

test("three rounds: challenge, defence, final answer; only the answers that were asked for count", () => {
  const p = D.startDebate([A, B]);
  // round 1: each judges the other's points; B also says A missed something
  let nA = D.needsOf(p, 0);
  let nB = D.needsOf(p, 1);
  assert.deepEqual([nA.judge.map((x) => x.id), nB.judge.map((x) => x.id)], [["B1"], ["A1", "A2"]]);
  const rA = D.parseReply(block({ answers: [{ id: "B1", stance: "agree", why: "checked :44" }, { id: "A1", stance: "concede", why: "not asked" }, { id: "Z9", stance: "agree" }], missed: [] }));
  const rB = D.parseReply(block({ answers: [{ id: "a1", stance: "Refute", why: "Q3 is not a dependency, see :15" }, { id: "A2", stance: "can't tell", why: "" }], missed: [{ severity: "high", location: "roadmap.md:60", what: "Budget line is missing" }] }));
  assert.equal(D.applyReply(p, 0, rA, 1, nA, true), 1); // conceding its own point unasked, and an id that doesn't exist, are ignored
  assert.equal(D.applyReply(p, 1, rB, 1, nB, true), 3);
  assert.equal(p.find((x) => x.id === "B1")!.status, "confirmed");
  assert.deepEqual(p.map((x) => x.id), ["A1", "A2", "B1", "B2"]);
  assert.equal(p.find((x) => x.id === "B2")!.raised, 1);

  // round 2: A defends what was attacked and judges the new point; B has nothing to do
  nA = D.needsOf(p, 0);
  nB = D.needsOf(p, 1);
  assert.deepEqual(nA.defend.map((x) => x.id), ["A1", "A2"]);
  assert.deepEqual(nA.judge.map((x) => x.id), ["B2"]);
  assert.deepEqual([nB.defend.length, nB.judge.length], [0, 0]);
  const lines = D.crossLines(p, 0, 2, nA).join("\n");
  assert.match(lines, /They said \(refute\): Q3 is not a dependency/);
  assert.match(lines, /B2 \[high\] roadmap\.md:60: Budget line is missing/);
  D.applyReply(p, 0, D.parseReply(block({ answers: [{ id: "A1", stance: "hold", why: ":12 says 'after Q3 ships'" }, { id: "A2", stance: "concede", why: "an owner is named at :31" }, { id: "B2", stance: "refute", why: "budget is in the appendix" }] })), 2, nA, true);
  assert.equal(p.find((x) => x.id === "A2")!.status, "dropped");

  // round 3: B answers A's defence, and defends its own attacked point; nothing new may be raised
  nB = D.needsOf(p, 1);
  assert.deepEqual([nB.judge.map((x) => x.id), nB.defend.map((x) => x.id)], [["A1"], ["B2"]]);
  assert.match(D.crossLines(p, 1, 3, nB).join("\n"), /last round[\s\S]*Raise nothing new/);
  const before = p.length;
  D.applyReply(p, 1, D.parseReply(block({ answers: [{ id: "A1", stance: "agree", why: "yes, :12" }, { id: "B2", stance: "hold", why: "the appendix has no figure" }], missed: [{ what: "too late for this" }] })), 3, nB, false);
  assert.equal(p.length, before);
  D.closeDebate(p);
  assert.deepEqual(Object.fromEntries(p.map((x) => [x.id, x.status])), { A1: "confirmed", A2: "dropped", B1: "confirmed", B2: "disputed" });
  assert.deepEqual(D.tally(p), { confirmed: 2, dropped: 1, disputed: 1, open: 0 });

  const ledger = D.ledgerText(p, ["m-a", "m-b"]);
  assert.match(ledger, /Still disputed \(1\)[\s\S]*B2 \[high\][\s\S]*m-a — refute: budget is in the appendix[\s\S]*m-b — hold: the appendix has no figure/);
  assert.match(ledger, /Dropped \(1\)[\s\S]*A2/);
});

test("a reply with no readable block changes nothing; junk in a block is dropped", () => {
  assert.equal(D.parseReply("no block"), undefined);
  assert.equal(D.parseReply("```qa-hound-debate\nnot json\n```"), undefined);
  const r = D.parseReply(block({ answers: [{ id: "A1", stance: "destroy" }, { id: "A1; rm -rf", stance: "agree" }, "x"], missed: [{ what: "" }, { what: "real `one`\nwith a newline", severity: "enormous" }] }))!;
  assert.deepEqual(r.answers, []);
  assert.deepEqual(r.missed, [{ severity: undefined, location: undefined, what: "real one with a newline" }]);
  const p = D.startDebate([A, B]);
  assert.equal(D.applyReply(p, 0, undefined, 1, D.needsOf(p, 0), true), 0);
});

// ---- a whole run, with scripted reviewers that argue ----
const asked: Array<{ model: string; prompt: string }> = [];
for (const id of ["opencode", "claude"] as const)
  engines[id] = {
    id,
    label: "Scripted",
    async *run(input) {
      asked.push({ model: input.model, prompt: input.prompt });
      const p = input.prompt;
      let text: string;
      if (p.includes("A QA Hound review just finished")) text = 'Weighed.\n\n```qa-hound\n{"verdict":"fix-first","findings":[]}\n```';
      else if (p.includes("Challenge round."))
        text = input.model === "m-a" ? block({ answers: [{ id: "B1", stance: "refute", why: "there is a fallback at :50" }], missed: [] }) : block({ answers: [{ id: "A1", stance: "agree", why: "ok" }, { id: "A2", stance: "refute", why: "owner is at :31" }], missed: [] });
      else if (p.includes("Cross-examination, round 2")) text = input.model === "m-a" ? block({ answers: [{ id: "A2", stance: "concede", why: "true" }] }) : block({ answers: [{ id: "B1", stance: "hold", why: ":50 is a different milestone" }] });
      else if (p.includes("Cross-examination, round 3")) text = block({ answers: [{ id: "B1", stance: "refute", why: "same milestone, see heading" }] });
      else text = input.model === "m-a" ? A : B;
      yield { type: "text", delta: text };
      yield { type: "done", engineSessionId: "scripted", usage: { costUsd: 0.01 } };
    },
  };

test("a run cross-examines for as many rounds as there is something to answer, and the verdict gets the ledger", async () => {
  W._setSwarmNet(async () => true);
  mkdirSync(path.join(paths.workspace, "uploads"), { recursive: true });
  writeFileSync(path.join(paths.workspace, "uploads", "roadmap.md"), "# Roadmap\n");
  const chat = sessions.create({ title: "New chat", engine: "opencode", model: "judge" });
  const run = W.startSwarm({ sessionId: chat.id, target: "uploads/roadmap.md", models: ["m-a", "m-b"], options: { budgetUsd: 5 } });
  let s = W.getSwarm(run.id)!;
  for (let i = 0; i < 400 && !((s.phase === "done" || s.phase === "error") && s.finishedAt); i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(s.phase, "done", s.error ?? "");
  assert.equal(s.round, 3);
  assert.deepEqual(Object.fromEntries(s.debate!.map((x) => [x.id, x.status])), { A1: "confirmed", A2: "dropped", B1: "disputed" });
  // round 3 was only put to the one with something to answer (m-a, on B1's defence)
  assert.deepEqual(asked.filter((a) => a.prompt.includes("Cross-examination, round 3")).map((a) => a.model), ["m-a"]);
  const verdict = asked.find((a) => a.prompt.includes("A QA Hound review just finished"))!.prompt;
  assert.match(verdict, /Settle every disputed point yourself/);
  assert.match(verdict, /Still disputed \(1\)[\s\S]*B1 \[medium\]/);
  assert.ok(s.log.some((l) => /Cross-examination over after 3 rounds: 1 confirmed, 1 dropped, 1 left for the verdict/.test(l.text)));
  // each reviewer's rounds are kept together for the verdict
  assert.match(s.reviewers[0].rebuttal ?? "", /### Round 1[\s\S]*### Round 2[\s\S]*### Round 3/);
  assert.equal(W.publicSwarm(s).debate?.length, 3);
});
