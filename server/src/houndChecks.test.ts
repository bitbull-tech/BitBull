import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { houndOptions, parseFindings, prBody, type Finding } from "./hound.js";
import { checkQuote, commitCheck, coverageCheck, plant, plantable, plantedCaught, plantedCheck, quotesCheck, removePlanted, safeName, verifyFindings } from "./houndChecks.js";

const ws = mkdtempSync(path.join(tmpdir(), "bitbull-checks-"));
const repo = path.join(ws, "app");
mkdirSync(path.join(repo, "src", "lib"), { recursive: true });
const auth = ["import { db } from './db'", "", "export function login(user: string, pass: string) {", "  const row = db.get(user)", "  if (row.pass == pass) {", "    return   makeToken(user)", "  }", "  return null", "}", ""].join("\n");
writeFileSync(path.join(repo, "src", "auth.ts"), auth + "// padding ".repeat(30) + "\n");
writeFileSync(path.join(repo, "src", "lib", "util.py"), "def add(a, b):\n    return a + b\n" + "# padding\n".repeat(40));
writeFileSync(path.join(repo, "README.md"), "# app\n" + "words ".repeat(100));
const outside = mkdtempSync(path.join(tmpdir(), "bitbull-outside-"));
writeFileSync(path.join(outside, "secret.ts"), "export const secret = 'the outside file content'\n");
symlinkSync(path.join(outside, "secret.ts"), path.join(repo, "src", "link.ts"));
const roots = [repo, ws];

const f = (over: Partial<Finding>): Finding => ({ severity: "high", confidence: 90, path: "src/auth.ts", title: "t", foundBy: [], status: "single", shown: true, ...over });

test("a quote is looked up in the file it names, white space aside, and gives the line", () => {
  assert.deepEqual(checkQuote(ws, roots, { path: "src/auth.ts", line: 40, quote: "if (row.pass == pass) {" }), { evidence: "verified", line: 5 });
  // several lines, differently indented, and a path with a line suffix or the repo's name in front
  assert.equal(checkQuote(ws, roots, { path: "src/auth.ts:5", quote: "if (row.pass == pass) {\n      return makeToken(user)" }).evidence, "verified");
  assert.equal(checkQuote(ws, roots, { path: "app/src/auth.ts", quote: "return makeToken(user)" }).evidence, "verified");
  // code that isn't there, a file that isn't there, the right code in the wrong file
  assert.equal(checkQuote(ws, roots, { path: "src/auth.ts", quote: "if (row.pass === hash(pass)) {" }).evidence, "mismatch");
  assert.equal(checkQuote(ws, roots, { path: "src/nope.ts", quote: "if (row.pass == pass) {" }).evidence, "mismatch");
  assert.equal(checkQuote(ws, roots, { path: "src/lib/util.py", quote: "if (row.pass == pass) {" }).evidence, "mismatch");
  // nothing to check: no quote, or one too short to mean anything
  assert.equal(checkQuote(ws, roots, { path: "src/auth.ts" }).evidence, "none");
  assert.equal(checkQuote(ws, roots, { path: "src/auth.ts", quote: "}" }).evidence, "none");
  assert.equal(checkQuote(ws, roots, { path: "", quote: "if (row.pass == pass) {" }).evidence, "none");
});

test("a quote can't be matched against a file outside the workspace", () => {
  assert.equal(checkQuote(ws, roots, { path: "src/link.ts", quote: "export const secret = 'the outside file content'" }).evidence, "mismatch");
  assert.equal(checkQuote(ws, roots, { path: "../../etc/hostname", quote: "anything at all here" }).evidence, "mismatch");
});

test("a finding whose quote isn't in the file is held back; too many and the list isn't relied on", () => {
  const good = f({ quote: "if (row.pass == pass) {", line: 1 });
  const bad = f({ title: "invented", quote: "eval(request.body.code) // never written" });
  const bare = f({ title: "no tests", path: "" });
  const out = verifyFindings(ws, roots, [good, bad, bare]);
  assert.equal(out[0].evidence, "verified");
  assert.equal(out[0].line, 5);
  assert.equal(out[1].shown, false);
  assert.match(out[1].heldBecause!, /isn't in that file/);
  assert.equal(out[2].evidence, "none");
  assert.equal(out[2].shown, true);
  // 1 of 2 quoted is wrong: not relied on
  assert.equal(quotesCheck(out).ok, false);
  // 1 slip in 6 is reformatting
  const six = verifyFindings(ws, roots, [...Array.from({ length: 5 }, () => good), bad]);
  assert.equal(quotesCheck(six).ok, true);
  assert.match(quotesCheck(six).text, /5 of 6/);
  assert.equal(quotesCheck(verifyFindings(ws, roots, [bad, bad, good, good, good, good, good, good, good, good, good, good])).ok, false);
  assert.equal(quotesCheck([]).ok, true);
});

test("the handler's quote survives parsing with its line breaks", () => {
  const text = "```qa-hound\n" + JSON.stringify({ verdict: "fix-first", findings: [{ severity: "high", confidence: 90, path: "src/auth.ts", title: "plain compare", quote: "if (row.pass == pass) {\n    return makeToken(user)" }] }) + "\n```";
  const { findings } = parseFindings(text, houndOptions({}));
  assert.ok(findings);
  assert.equal(verifyFindings(ws, roots, findings)[0].evidence, "verified");
});

test("coverage: every changed file has to have been opened, whichever way the path was written", () => {
  const changed = ["src/auth.ts", "src/lib/util.py", "README.md"];
  const all = coverageCheck(changed, [path.join(repo, "src/auth.ts"), "app/src/lib/util.py", "/some/other/mount/app/README.md", "app/src"], ws, repo);
  assert.equal(all.ok, true, all.text);
  const some = coverageCheck(changed, [path.join(repo, "src/auth.ts"), "app/src", "app"], ws, repo);
  assert.equal(some.ok, false);
  assert.match(some.text, /2 of 3 changed files were not opened.*src\/lib\/util\.py.*README\.md/);
  // a same-named file in another clone doesn't count
  assert.equal(coverageCheck(["src/auth.ts"], ["other/src/auth.ts"], ws, repo).ok, false);
  // and when the list couldn't be had, there is no proof
  assert.equal(coverageCheck(undefined, [], ws, repo, "GitHub 403").ok, false);
  assert.equal(safeName("src/a.ts"), "src/a.ts");
  for (const bad of ["a`b", "a\nb", "../x", "a/../../b", 7, "x".repeat(400)]) assert.equal(safeName(bad), null);
});

test("commit: the copy reviewed has to be the pull request's commit, with nothing uncommitted", () => {
  assert.equal(commitCheck("abc1234", "abc1234def567890", 0).ok, true);
  assert.equal(commitCheck("abc1234", "fff0000def567890", 0).ok, false);
  assert.equal(commitCheck("abc1234", "abc1234def567890", 2).ok, false);
  assert.equal(commitCheck(undefined, "abc1234def567890", 0).ok, false);
});

test("planted defects: a scratch copy with two known defects, found or missed, then removed", () => {
  assert.deepEqual(plantable(repo), ["src/auth.ts", "src/lib/util.py"]);
  assert.deepEqual(plantable(repo, ["src/lib/util.py", "README.md", "src/link.ts"]), ["src/lib/util.py", "src/auth.ts"]);
  const p = plant(ws, repo, "0123-abcd-run", [])!;
  assert.ok(p);
  assert.equal(p.dir, ".hound-work/0123-abcd-ru/app");
  assert.equal(p.planted.length, 2);
  // the originals are untouched; the copies end with the planted code at the lines recorded
  assert.doesNotMatch(readFileSync(path.join(repo, "src/auth.ts"), "utf8"), /findAccountByName/);
  const [inj, acc] = p.planted;
  const copy = readFileSync(path.join(ws, p.dir, inj.file), "utf8").split("\n");
  assert.match(copy[inj.from - 1], /findAccountByName/);
  assert.match(copy[inj.to - 1], /^}/);
  assert.match(readFileSync(path.join(ws, p.dir, acc.file), "utf8"), /def can_remove_document/);
  // the symlink out of the workspace was not copied
  assert.ok(!existsSync(path.join(ws, p.dir, "src/link.ts")));

  // found by line, found by naming the function, and not found by a finding elsewhere in the file
  const both = plantedCaught(p, [f({ path: `${p.dir}/${inj.file}`, line: inj.from + 1 }), f({ path: acc.file, title: "can_remove_document lets non-owners delete" })]);
  assert.deepEqual(both, { caught: ["injection", "access"], missed: [] });
  const one = plantedCaught(p, [f({ path: inj.file, line: 4, title: "loose compare" }), f({ path: "other.py", title: "can_remove_document is wrong" })]);
  assert.deepEqual(one, { caught: [], missed: ["injection", "access"] });

  assert.equal(plantedCheck([{ model: "a", ...both }, { model: "b", ...both }]).ok, true);
  const failed = plantedCheck([{ model: "a", ...both }, { model: "b", caught: ["injection"], missed: ["access"] }]);
  assert.equal(failed.ok, false);
  assert.match(failed.text, /b missed the inverted ownership check/);
  assert.equal(plantedCheck([{ model: "a", caught: [], missed: ["injection", "access"], error: "no readable findings" }]).ok, false);
  assert.equal(plantedCheck(undefined, "no source files").ok, false);

  removePlanted(ws, "0123-abcd-run");
  assert.ok(!existsSync(path.join(ws, ".hound-work")));
  // nothing to plant in: no test
  const docs = mkdtempSync(path.join(tmpdir(), "bitbull-docs-"));
  writeFileSync(path.join(docs, "a.md"), "x".repeat(500));
  assert.equal(plant(docs, docs, "x", []), null);
});

test("the review lists what BitBull checked, and says when it stopped an approval", () => {
  const body = prBody({ target: "app", models: ["a"], verdict: "use", findings: [], spentUsd: 0.1, approving: true, checks: [commitCheck("abc1234", "abc1234def", 0), coverageCheck(["a.ts"], [], ws, repo)] });
  assert.match(body, /What BitBull checked itself\*\* \(not all passed, so this is not an approval\)/);
  assert.match(body, /- ✅ Commit:/);
  assert.match(body, /- ❌ Coverage: 1 of 1 changed file was not opened/);
});
