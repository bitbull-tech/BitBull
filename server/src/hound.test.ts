import assert from "node:assert/strict";
import { test } from "node:test";
import { globRe, houndOptions, inScope, parseFindings, prBody, prEvent } from "./hound.js";
import { parseRouterModels, sameModel } from "./router.js";
import { parseGithubRemote } from "./github.js";

test("options are clamped and defaulted", () => {
  const o = houndOptions({ budgetUsd: 500, maxMinutes: 1, minSeverity: "HIGH", minConfidence: 150, include: "src/**\n\n../etc", pr: "yes" });
  assert.equal(o.budgetUsd, 100);
  assert.equal(o.maxMinutes, 5);
  assert.equal(o.minSeverity, "high");
  assert.equal(o.minConfidence, 100);
  assert.deepEqual(o.include, ["src/**"]);
  assert.equal(o.pr, false);
  assert.equal(houndOptions().budgetUsd, 2);
});

test("scope globs: exclude wins, bare names match anywhere", () => {
  assert.ok(globRe("src/**").test("src/a/b.ts"));
  assert.ok(globRe("*.md").test("docs/x.md"));
  assert.ok(!globRe("src/*.ts").test("src/a/b.ts"));
  assert.ok(inScope("src/a.ts:12", ["src/**"], []));
  assert.ok(!inScope("src/gen/a.ts", ["src/**"], ["**/gen/**"]));
  assert.ok(inScope("anything.py", [], []));
});

const block = (j: unknown) => `Verdict text\n\n\`\`\`qa-hound\n${JSON.stringify(j)}\n\`\`\``;

test("findings are typed, judged by the thresholds, and ranked", () => {
  const o = houndOptions({ minSeverity: "medium", minConfidence: 70, exclude: ["tests/**"] });
  const { verdict, findings } = parseFindings(
    block({
      verdict: "fix-first",
      findings: [
        { severity: "low", confidence: 95, path: "src/a.ts", title: "nit" },
        { severity: "critical", confidence: 92, path: "src/auth.ts", line: 40, title: "token leak", foundBy: ["a", "b"], status: "confirmed" },
        { severity: "high", confidence: 50, path: "src/b.ts", title: "maybe race", status: "disputed" },
        { severity: "high", confidence: 90, path: "tests/x.ts", title: "flaky" },
        { severity: "bogus", title: "" },
        "junk",
      ],
    }),
    o,
  );
  assert.equal(verdict, "fix-first");
  assert.ok(findings);
  assert.equal(findings.length, 4);
  assert.equal(findings[0].title, "token leak");
  assert.ok(findings[0].shown);
  const held = Object.fromEntries(findings.filter((f) => !f.shown).map((f) => [f.title, f.heldBecause]));
  assert.match(held["nit"]!, /below medium/);
  assert.match(held["maybe race"]!, /confidence 50 < 70/);
  assert.match(held["flaky"]!, /scope/);
  assert.equal(prEvent(findings, o, true), "REQUEST_CHANGES");
  assert.equal(prEvent(findings.filter((f) => f.title !== "token leak"), o, true), "APPROVE");
  assert.equal(prEvent([], o, false), "COMMENT");
  const body = prBody({ target: "repo", models: ["a", "b"], verdict: "fix-first", findings, spentUsd: 0.4 });
  assert.match(body, /token leak/);
  assert.doesNotMatch(body, /maybe race/);
  assert.match(body, /3 more findings held back/);
  assert.equal(parseFindings("no block here", o).findings, undefined);
  assert.equal(parseFindings("```qa-hound\n{not json\n```", o).findings, undefined);
});

test("Router models: per-token and per-million prices, matching across prefixes", () => {
  const m = parseRouterModels({ data: [{ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", pricing: { prompt: "0.00000015", completion: "0.0000005" }, context_length: 200000 }, { id: "x/y", price: { input: 3, output: 15 } }, { nope: 1 }] });
  assert.equal(m.length, 2);
  assert.deepEqual(m.find((x) => x.id === "z-ai/glm-5.3-flash")?.price, { input: 0.15, output: 0.5 });
  assert.deepEqual(m.find((x) => x.id === "x/y")?.price, { input: 3, output: 15 });
  assert.ok(sameModel("z-ai/glm-5.3-flash", "GLM-5.3-flash"));
  assert.ok(!sameModel("gpt-6-luna", "glm-5.3-flash"));
});

test("GitHub remotes", () => {
  assert.deepEqual(parseGithubRemote("https://github.com/tommyhgunz14/BitBull.git"), { owner: "tommyhgunz14", repo: "BitBull" });
  assert.deepEqual(parseGithubRemote("git@github.com:tommyhgunz14/BitBull"), { owner: "tommyhgunz14", repo: "BitBull" });
  assert.equal(parseGithubRemote("https://gitlab.com/a/b.git"), null);
});
