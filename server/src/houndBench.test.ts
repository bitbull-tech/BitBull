/** The benchmark's scoring, and a whole benchmark run with a scripted model. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-bench-"));
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";

const { paths } = await import("./config.js");
const { engines } = await import("./agent.js");
const { BENCH_PASS, BENCH_TOTAL, CASES, benchState, gradeOf, scoreCase, startBench } = await import("./houndBench.js");
type Finding = import("./hound.js").Finding;
type AgentEvent = import("./engines/types.js").AgentEvent;
type RunInput = import("./engines/types.js").RunInput;

const f = (over: Partial<Finding>): Finding => ({ severity: "high", confidence: 90, path: "", title: "t", foundBy: [], status: "single", shown: true, ...over });
const lineOf = (c: (typeof CASES)[number], file: string, anchor: string) => c.files[file].split("\n").findIndex((l) => l.includes(anchor)) + 1;

test("the cases: twelve defects, each anchored to one line of its file, and a clean file in each", () => {
  assert.equal(BENCH_TOTAL, 12);
  for (const c of CASES) {
    for (const d of c.defects) {
      const hits = c.files[d.file].split("\n").filter((l) => l.includes(d.anchor));
      assert.equal(hits.length, 1, `${c.id}: ${d.label}`);
    }
    for (const file of c.clean) {
      assert.ok(c.files[file], file);
      assert.ok(!c.defects.some((d) => d.file === file));
    }
  }
});

test("scoring: by place or by subject; a nit in the same file is not a catch; alarms in clean files count", () => {
  const web = CASES.find((c) => c.id === "web")!;
  // by line
  let s = scoreCase(web, [f({ path: "src/files.ts", line: lineOf(web, "src/files.ts", "path.join(UPLOADS") })]);
  assert.deepEqual(s.caught, ["path traversal in openUpload"]);
  // by subject, with a path written from the workspace root and no line
  s = scoreCase(web, [f({ path: ".hound-bench/x/web/src/admin.ts", title: "isAdmin is not awaited, so the check always passes" })]);
  assert.deepEqual(s.caught, ["missing await on the admin check"]);
  // by quote
  s = scoreCase(web, [f({ path: "src/files.ts", line: 99, quote: "const file =   path.join(UPLOADS, req.query.name);" })]);
  assert.equal(s.caught.length, 1);
  // session.ts holds two: the subject has to fit, the place alone doesn't say which
  s = scoreCase(web, [f({ path: "src/session.ts", line: lineOf(web, "src/session.ts", "Math.random"), title: "newResetCode uses Math.random, which is predictable" })]);
  assert.deepEqual(s.caught, ["Math.random for a reset code"]);
  s = scoreCase(web, [f({ path: "src/session.ts", line: 3, title: "hex encoding is slow" })]);
  assert.deepEqual(s.caught, []);
  // the wrong file, and an unrelated remark at the far end of the right one
  s = scoreCase(web, [f({ path: "src/format.ts", title: "path traversal" }), f({ path: "src/admin.ts", line: 2, title: "interface could be exported" })]);
  assert.deepEqual(s.caught, []);
  assert.equal(s.falseAlarms, 1);
  // a low-severity or unsure remark about a clean file is not an alarm
  s = scoreCase(web, [f({ path: "src/format.ts", severity: "low" }), f({ path: "src/format.ts", confidence: 40 })]);
  assert.equal(s.falseAlarms, 0);
});

// A scripted model: finds what it is told to, by reading the anchors out of the cases.
let skip: string[] = [];
let alarms = 0;
let prompts = 0;
engines.opencode = {
  id: "opencode",
  label: "Scripted",
  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    prompts++;
    assert.equal(input.plan, true);
    const c = CASES.find((x) => input.prompt.includes(`/${x.id}/\``))!;
    assert.ok(c, "the prompt names the case folder");
    assert.ok(existsSync(path.join(paths.workspace, /`(\.hound-bench\/[^`]+)\/`/.exec(input.prompt)![1], c.clean[0])));
    const findings: unknown[] = c.defects.filter((d) => !skip.includes(d.label)).map((d) => ({ severity: "high", confidence: 90, path: d.file, line: lineOf(c, d.file, d.anchor), title: d.label, quote: d.anchor }));
    for (let i = 0; i < alarms; i++) findings.push({ severity: "high", confidence: 90, path: c.clean[0], title: "invented" });
    yield { type: "text", delta: "report\n```qa-hound\n" + JSON.stringify({ findings }) + "\n```" };
    yield { type: "done", engineSessionId: "e" };
  },
};
async function bench(model: string) {
  const r = startBench(model);
  assert.equal(r.ok, true, r.message);
  for (let i = 0; i < 200 && benchState().running.length; i++) await new Promise((res) => setTimeout(res, 25));
  assert.equal(benchState().running.length, 0);
  return benchState().results.find((x) => x.model === model)!;
}

test("a model that finds them all passes; the scratch folder is gone afterwards", async () => {
  const r = await bench("careful-model");
  assert.equal(prompts, 3);
  assert.equal(r.caught, 12);
  assert.equal(r.grade, true);
  assert.deepEqual(r.missed, []);
  assert.ok(gradeOf("careful-model")?.grade);
  assert.ok(!existsSync(path.join(paths.workspace, ".hound-bench")));
});

test("too many missed, or too many false alarms: not approval-grade", async () => {
  skip = CASES.flatMap((c) => c.defects.map((d) => d.label)).slice(0, BENCH_TOTAL - BENCH_PASS.caught + 1);
  let r = await bench("sloppy-model");
  assert.equal(r.caught, BENCH_PASS.caught - 1);
  assert.equal(r.grade, false);
  assert.equal(r.missed.length, 3);
  skip = [];
  alarms = 1; // one in each of the three clean files
  r = await bench("jumpy-model");
  assert.equal(r.caught, 12);
  assert.equal(r.falseAlarms, 3);
  assert.equal(r.grade, false);
  alarms = 0;
  assert.equal(gradeOf("never-run"), undefined);
  assert.equal(startBench("").ok, false);
});
