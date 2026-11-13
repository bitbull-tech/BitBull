/** Usage: replies' estimated costs, per local day and per model, every day in range present. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-usage-"));
const { db, sessions } = await import("./db.js");
const { usageReport } = await import("./usage.js");

test("per day (at local midnight) and per model, with unpriced replies counted", () => {
  const s = sessions.create({ engine: "opencode", model: "a" });
  const add = (at: string, model: string, usage: unknown, role = "assistant") =>
    db.prepare("INSERT INTO messages (id, session_id, role, content, model, usage_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
      `${at}-${model}-${Math.random()}`, s.id, role, "x", model, usage === null ? null : JSON.stringify(usage), Date.parse(at),
    );
  add("2026-11-12T10:00:00Z", "deepseek", { costUsd: 0.01, inputTokens: 100, outputTokens: 10 });
  add("2026-11-12T23:30:00Z", "claude", { costUsd: 0.5, inputTokens: 1000, outputTokens: 200 }); // 13th in UTC+1
  add("2026-11-13T09:00:00Z", "deepseek", { costUsd: 0.02, inputTokens: 200, outputTokens: 20 });
  add("2026-11-13T09:05:00Z", "mystery", { inputTokens: 5, outputTokens: 5 }); // no price
  add("2026-11-13T09:06:00Z", "deepseek", { costUsd: 9 }, "user"); // not a reply
  add("2026-10-01T09:00:00Z", "deepseek", { costUsd: 7 }); // out of range

  const now = Date.parse("2026-11-13T12:00:00Z");
  const utc = usageReport(7, 0, now);
  assert.equal(utc.byDay.length, 7);
  assert.equal(utc.from, "2026-11-07");
  assert.equal(utc.to, "2026-11-13");
  assert.equal(utc.byDay.at(-2)!.cost, 0.51);
  assert.equal(utc.byDay.at(-1)!.replies, 2);
  assert.equal(utc.total.replies, 4);
  assert.equal(Math.round(utc.total.cost * 100), 53);
  assert.equal(utc.unpriced, 1);
  assert.deepEqual(utc.byModel.map((m) => m.model), ["claude", "deepseek", "mystery"]);
  assert.equal(utc.byModel[1].inputTokens, 300);

  // in UTC+1 the late reply belongs to the 13th
  const plus1 = usageReport(7, 60, now);
  assert.equal(Math.round(plus1.byDay.at(-1)!.cost * 100), 52);
  assert.deepEqual(Object.keys(plus1.byDay.at(-1)!.byModel).sort(), ["claude", "deepseek", "mystery"]);
});
