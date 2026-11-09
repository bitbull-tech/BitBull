import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// config and db read the environment at import time
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-advisor-"));
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";

const { db, messages, sessions } = await import("./db.js");
const { needsOf, parseAdvice, shortlist, tableRow, usageByModel } = await import("./advisor.js");
type ModelInfo = import("./models.js").ModelInfo;

const model = (id: string, input: number, output: number, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name: id.toUpperCase(),
  family: "open",
  api: "chat",
  tools: true,
  price: { input, output },
  ...extra,
});

test("usage per model comes from stored turns and replies", () => {
  const s = sessions.create({ title: "t", engine: "opencode", model: "kimi-k3" });
  const turn = db.prepare("INSERT INTO turns (id, session_id, status, model, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)");
  turn.run("t1", s.id, "done", "kimi-k3", 1000, 5000);
  turn.run("t2", s.id, "done", "kimi-k3", 6000, 8000);
  turn.run("t3", s.id, "error", "kimi-k3", 9000, 9500);
  turn.run("t4", s.id, "aborted", "glm-5", 10000, 11000);
  messages.add({ session_id: s.id, role: "assistant", content: "a", model: "kimi-k3", tools_json: null, usage_json: JSON.stringify({ inputTokens: 20000, outputTokens: 1000, costUsd: 0.02 }) });
  messages.add({ session_id: s.id, role: "assistant", content: "b", model: "kimi-k3", tools_json: null, usage_json: JSON.stringify({ inputTokens: 40000, outputTokens: 3000, costUsd: 0.04 }) });
  messages.add({ session_id: s.id, role: "assistant", content: "c", model: "kimi-k3", tools_json: null, usage_json: "not json" });
  messages.add({ session_id: s.id, role: "user", content: "q", model: null, tools_json: null, usage_json: null });

  const u = usageByModel();
  const k = u.find((x) => x.id === "kimi-k3")!;
  assert.equal(k.turns, 3);
  assert.equal(k.done, 2);
  assert.equal(k.errors, 1);
  assert.equal(k.replies, 2);
  assert.ok(Math.abs(k.totalCostUsd - 0.06) < 1e-9);
  assert.ok(Math.abs((k.avgCostUsd ?? 0) - 0.03) < 1e-9);
  assert.equal(k.avgInputTokens, 30000);
  assert.equal(k.avgSeconds, 3); // done turns only: 4s and 2s
  const g = u.find((x) => x.id === "glm-5")!;
  assert.equal(g.stopped, 1);
  assert.equal(u[0].id, "kimi-k3"); // most used first
});

test("the shortlist keeps only models that can do it, yours first, then cheapest", () => {
  const models = [
    model("pricey", 10, 40),
    model("cheap", 0.1, 0.4),
    model("no-tools", 0.01, 0.01, { tools: false }),
    model("no-price", 0.01, 0.01, { price: undefined }),
    model("sees", 1, 4, { vision: true }),
    model("mine", 3, 15),
  ];
  const usage = new Map([["mine", { id: "mine", turns: 12, done: 12, errors: 0, stopped: 0, replies: 12, totalCostUsd: 1 }]]);
  assert.deepEqual(
    shortlist(models, { vision: false }, usage).map((m) => m.id),
    ["mine", "cheap", "sees", "pricey"],
  );
  assert.deepEqual(shortlist(models, { vision: true }, usage).map((m) => m.id), ["sees"]);
  assert.equal(needsOf("Transcribe these scanned letters (JPEG)").vision, true);
  assert.equal(needsOf("Refactor the egress proxy").vision, false);
  assert.match(tableRow(models[5], usage.get("mine")), /^mine \| open \| \$3\.00\/\$15\.00 \| \? \| - \| 12 turns, 0% errors$/);
});

test("advice is only accepted from the shortlist, one model per role", () => {
  const allowed = new Map([model("a", 1, 2), model("b", 0.1, 0.2), model("c", 5, 10)].map((m) => [m.id, m]));
  const text =
    "Sure! ```json\n" +
    JSON.stringify({
      estimate: { inputTokens: 120000, outputTokens: 8000, turns: 4 },
      picks: [
        { id: "c", role: "best-quality", why: "strongest", pros: ["good"], cons: ["dear"] },
        { id: "made-up", role: "best-value", why: "x" },
        { id: "a", role: "best-value", why: "balanced", pros: ["ok", "", 3] },
        { id: "a", role: "cheapest", why: "again" },
        { id: "b", role: "cheapest", why: "cheap", cons: ["weaker"] },
        { id: "b", role: "best-quality", why: "dup role" },
      ],
    }) +
    "\n```";
  const { picks, estimate } = parseAdvice(text, allowed);
  assert.deepEqual(picks.map((p) => `${p.role}:${p.id}`), ["best-value:a", "best-quality:c", "cheapest:b"]);
  assert.deepEqual(picks[0].pros, ["ok"]);
  assert.equal(picks[1].name, "C");
  assert.deepEqual(estimate, { inputTokens: 120000, outputTokens: 8000, turns: 4 });
  assert.throws(() => parseAdvice("no json here", allowed), /expected format/);
  assert.throws(() => parseAdvice('{"picks":[{"id":"zzz","role":"cheapest"}]}', allowed), /no model/);
  // sizes are clamped, not trusted
  const e = parseAdvice('{"estimate":{"inputTokens":-5,"turns":9999},"picks":[{"id":"a","role":"cheapest"}]}', allowed).estimate;
  assert.deepEqual(e, { inputTokens: 1000, outputTokens: 3000, turns: 200 });
});
