/**
 * A whole QA Hound run with scripted models and a stand-in GitHub: does an approval really wait
 * for the checks BitBull runs itself (quotes, coverage, commit, planted defects)?
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-swarmchk-"));
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";
// not a real token: built here so nothing token-shaped is in the file
process.env.GITHUB_TOKEN = ["stand", "in", "value"].join("-");

const { paths } = await import("./config.js");
const { db, sessions } = await import("./db.js");
const { BENCH_VERSION } = await import("./houndBench.js");
const { engines } = await import("./agent.js");
const { startSwarm, getSwarm } = await import("./swarm.js");
type AgentEvent = import("./engines/types.js").AgentEvent;
type RunInput = import("./engines/types.js").RunInput;

const g = (dir: string, ...a: string[]) =>
  execFileSync("git", a, { cwd: dir, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x" } })
    .toString()
    .trim();

const ws = paths.workspace;
const repo = path.join(ws, "app");
mkdirSync(path.join(repo, "src"), { recursive: true });
g(repo, "init", "-q", "-b", "feature");
writeFileSync(path.join(repo, "src", "orders.ts"), "export function login(user: string, pass: string) {\n  if (stored(user) == pass) return token(user)\n  return null\n}\n" + "// more of the file\n".repeat(20));
writeFileSync(path.join(repo, "src", "util.ts"), "export const add = (a: number, b: number) => a + b\n" + "// more of the file\n".repeat(20));
g(repo, "add", ".");
g(repo, "commit", "-qm", "first");
g(repo, "remote", "add", "origin", "https://github.com/acme/app.git");
const head = g(repo, "rev-parse", "HEAD");

// ---- stand-in GitHub
let prHead = head;
let changedFiles = ["src/orders.ts", "src/util.ts"];
let ci: Array<{ name: string; status: string; conclusion: string | null }> = [{ name: "build", status: "completed", conclusion: "success" }];
// both reviewer models have passed the benchmark, unless a test says otherwise
const A = "kimi-k3";
const B = "deepseek-v4";
const grade = (model: string, caught = 12) => ({ model, version: BENCH_VERSION, ranAt: 1, caught, total: 12, falseAlarms: 0, missed: [], costUsd: 0, grade: caught >= 10 });
const setGrades = (list: unknown[]) =>
  db.prepare("INSERT INTO meta (key, value) VALUES ('hound_bench', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(Object.fromEntries((list as Array<{ model: string }>).map((g) => [g.model, g]))));
setGrades([grade(A), grade(B)]);
const posted: Array<{ event: string; body: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (!u.startsWith("https://api.github.com/")) throw new Error(`unexpected request to ${u}`);
  if (u.includes("/pulls?")) return json([{ number: 7, html_url: "https://github.com/acme/app/pull/7", title: "t", user: { login: "someone" }, head: { sha: prHead } }]);
  if (u.includes("/pulls/7/files")) return json([...changedFiles.map((filename) => ({ filename, status: "modified" })), { filename: "old.ts", status: "removed" }]);
  if (u.includes("/check-runs")) return json({ check_runs: ci });
  if (u.includes("/status")) return json({ statuses: [] });
  if (u.includes("/pulls/7/reviews")) {
    const b = JSON.parse(String(init?.body)) as { event: string; body: string };
    posted.push(b);
    return json({ html_url: "https://github.com/acme/app/pull/7#review" });
  }
  throw new Error(`unexpected GitHub call ${u}`);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

// ---- scripted models
const block = (j: unknown) => "```qa-hound\n" + JSON.stringify(j) + "\n```";
interface Script {
  /** files each reviewer opens in the review round */
  reads: string[];
  /** what a reviewer reports in the planted-defect test */
  planted: (model: string) => unknown[];
  /** the handler's findings block */
  final: unknown;
  /** each reviewer's own recommendation: [before reading the other, after] */
  says: (model: string) => [string, string];
  models: string[];
}
let script: Script;
let sawChanged = false;
let sawScratch = "";
engines.opencode = {
  id: "opencode",
  label: "Scripted",
  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    const p = input.prompt;
    if (p.startsWith("Review the code in `.hound-work/")) {
      sawScratch = /`(\.hound-work\/[^`]+)\/`/.exec(p)![1];
      assert.ok(existsSync(path.join(ws, sawScratch, "src", "orders.ts")));
      yield { type: "text", delta: "report\n" + block({ findings: script.planted(input.model) }) };
    } else if (p.startsWith("You are one of")) {
      if (p.includes("<changed-files>\nsrc/orders.ts\nsrc/util.ts\n</changed-files>")) sawChanged = true;
      let i = 0;
      for (const f of script.reads) yield { type: "tool_start", id: `t${i++}`, name: "read", input: { filePath: path.join(input.cwd, f) } };
      yield { type: "text", delta: `## Summary\nfine\n\nRECOMMENDATION: ${script.says(input.model)[0]}` };
    } else if (p.startsWith("Challenge round")) {
      yield { type: "text", delta: `## Final position\nsee above\n\n**RECOMMENDATION:** ${script.says(input.model)[1]}` };
    } else {
      yield { type: "text", delta: "Verdict.\n\n" + block(script.final) };
    }
    yield { type: "done", engineSessionId: "e" };
  },
};

const bothPlanted = () => [
  { severity: "critical", confidence: 95, path: "src/orders.ts", title: "findAccountByName builds SQL from name" },
  { severity: "high", confidence: 95, path: "src/util.ts", title: "canRemoveDocument lets anyone but the owner delete" },
];
const clean = { verdict: "use", findings: [] };

async function run(over: Partial<Script>, options: Record<string, unknown> = { pr: true, prApprove: true }) {
  script = { reads: ["app/src/orders.ts", "app/src/util.ts"], planted: bothPlanted, final: clean, says: () => ["use", "use"], models: [A, B], ...over };
  posted.length = 0;
  const chat = sessions.create({ engine: "opencode", model: "handler" });
  const s = startSwarm({ sessionId: chat.id, target: "app", models: script.models, options });
  for (let i = 0; i < 200 && !getSwarm(s.id)!.finishedAt; i++) await new Promise((r) => setTimeout(r, 50));
  const done = getSwarm(s.id)!;
  assert.ok(done.finishedAt, "the run finished");
  assert.equal(done.error, undefined);
  assert.equal(done.prError, undefined);
  return done;
}
const check = (s: { checks?: Array<{ id: string; ok: boolean; text: string }> }, id: string) => s.checks!.find((c) => c.id === id)!;

test("a clean run that passes every check approves, and says what was checked", async () => {
  const s = await run({});
  assert.equal(posted.length, 1);
  assert.equal(posted[0].event, "APPROVE");
  assert.deepEqual(
    s.checks!.map((c) => [c.id, c.ok]),
    [["quotes", true], ["coverage", true], ["commit", true], ["secrets", true], ["ci", true], ["people", true], ["planted", true], ["agreement", true], ["benchmark", true]],
  );
  assert.match(posted[0].body, /What BitBull checked itself/);
  assert.match(posted[0].body, /kimi-k3 found both; deepseek-v4 found both/);
  // the reviewers were told which files the pull request changes, and the scratch copy is gone
  assert.ok(sawChanged);
  assert.ok(sawScratch && !existsSync(path.join(ws, ".hound-work")));
});

test("approving is off by default: the same run only comments, and plants nothing", async () => {
  sawScratch = "";
  await run({}, { pr: true });
  assert.equal(posted[0].event, "COMMENT");
  assert.equal(sawScratch, "");
});

test("a changed file nobody opened: no approval", async () => {
  const s = await run({ reads: ["app/src/orders.ts"] });
  assert.equal(posted[0].event, "COMMENT");
  assert.equal(check(s, "coverage").ok, false);
  assert.match(posted[0].body, /❌ Coverage: 1 of 2 changed files was not opened by any reviewer: `src\/util\.ts`/);
});

test("a reviewer that misses a planted defect: no approval", async () => {
  const s = await run({ planted: (m) => (m === B ? bothPlanted().slice(0, 1) : bothPlanted()) });
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "planted").text, /kimi-k3 found both; deepseek-v4 missed the inverted ownership check/);
});

test("findings that quote code that isn't there: held back, and no approval", async () => {
  const s = await run({
    final: {
      verdict: "use",
      findings: [
        { severity: "low", confidence: 95, path: "src/orders.ts", title: "invented", quote: "eval(req.body.script) // not in the file" },
        { severity: "low", confidence: 95, path: "src/orders.ts", line: 9, title: "loose compare", quote: "if (stored(user) == pass) return token(user)" },
      ],
    },
  });
  assert.equal(posted[0].event, "COMMENT");
  assert.equal(check(s, "quotes").ok, false);
  const invented = s.findings!.find((f) => f.title === "invented")!;
  assert.equal(invented.shown, false);
  const real = s.findings!.find((f) => f.title === "loose compare")!;
  assert.equal(real.evidence, "verified");
  assert.equal(real.line, 2);
  assert.doesNotMatch(posted[0].body, /invented/);
});

test("the pull request moved on, or the copy has uncommitted work: no approval", async () => {
  prHead = "f".repeat(40);
  let s = await run({});
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "commit").text, /Sync the copy and run again/);
  prHead = head;
  writeFileSync(path.join(repo, "src", "new.ts"), "export {}\n");
  s = await run({});
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "commit").text, /1 uncommitted change/);
});

test("the reviewers have to agree on their own, and be from different model families", async () => {
  writeFileSync(path.join(repo, "src", "new.ts"), ""); // left over from the last test: commit it away
  g(repo, "add", ".");
  g(repo, "commit", "-qm", "second");
  prHead = g(repo, "rev-parse", "HEAD");
  // one reviewer only came round to "use" after reading the other: not independent
  let s = await run({ says: (m) => (m === B ? ["fix-first", "use"] : ["use", "use"]) });
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "agreement").text, /deepseek-v4 said "fix first" on its own and "use" after reading the other/);
  // the handler says use, a reviewer doesn't: the handler can't raise it
  s = await run({ says: (m) => (m === A ? ["do-not-use", "do-not-use"] : ["use", "use"]) });
  assert.equal(posted[0].event, "COMMENT");
  // two models from one maker
  setGrades([grade(A), grade("kimi-k2")]);
  s = await run({ models: [A, "kimi-k2"] });
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "agreement").text, /same model family \(Moonshot\)/);
  setGrades([grade(A), grade(B)]);
});

test("a reviewer model that hasn't passed the benchmark can't approve", async () => {
  setGrades([grade(A), grade(B, 7)]);
  let s = await run({});
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "benchmark").text, /deepseek-v4 did not pass \(found 7 of 12/);
  setGrades([grade(A)]);
  s = await run({});
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "benchmark").text, /deepseek-v4 hasn't been benchmarked/);
  // a result from an older version of the benchmark no longer counts
  setGrades([grade(A), { ...grade(B), version: BENCH_VERSION - 1 }]);
  s = await run({});
  assert.equal(check(s, "benchmark").ok, false);
  setGrades([grade(A), grade(B)]);
});

test("the project's own checks have to have passed on that commit", async () => {
  ci = [{ name: "build", status: "completed", conclusion: "failure" }];
  let s = await run({});
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "ci").text, /1 of 1 automated check failed/);
  ci = [{ name: "build", status: "in_progress", conclusion: null }];
  s = await run({});
  assert.match(check(s, "ci").text, /still running/);
  ci = [];
  s = await run({});
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "ci").text, /no automated checks/);
  ci = [{ name: "build", status: "completed", conclusion: "success" }];
});

test("sign-in, key and CI files always go to a person; a key in the change is called out without being shown", async () => {
  mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "name: ci\n");
  // built here so nothing key-shaped is in this file
  const keyLine = `const k = "${"gh" + "p_"}${"a1B2".repeat(10)}"`;
  writeFileSync(path.join(repo, "src", "util.ts"), `export const add = (a: number, b: number) => a + b\n${keyLine}\n`);
  g(repo, "add", ".");
  g(repo, "commit", "-qm", "third");
  prHead = g(repo, "rev-parse", "HEAD");
  changedFiles = ["src/orders.ts", "src/util.ts", ".github/workflows/ci.yml"];
  const s = await run({ reads: ["app/src/orders.ts", "app/src/util.ts", "app/.github/workflows/ci.yml"] });
  assert.equal(posted[0].event, "COMMENT");
  assert.match(check(s, "people").text, /a file that always goes to a person.*`\.github\/workflows\/ci\.yml`/);
  assert.doesNotMatch(check(s, "people").text, /orders/);
  assert.equal(check(s, "secrets").ok, false);
  assert.match(check(s, "secrets").text, /`src\/util\.ts:2`/);
  assert.doesNotMatch(posted[0].body, /a1B2a1B2/);
});
