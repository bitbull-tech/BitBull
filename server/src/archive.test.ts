import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-archive-"));
process.env.APP_TOKEN = "test-token";
const { projects, sessions, messages } = await import("./db.js");

test("archiving moves a project or chat aside without changing its order or contents", () => {
  const p = projects.create({ name: "Old work" });
  const s = sessions.create({ title: "A chat", engine: "opencode", model: "m", projectId: p.id });
  const before = sessions.get(s.id)!.updated_at;
  assert.ok(projects.setArchived(p.id, true)?.archived_at);
  assert.ok(sessions.setArchived(s.id, true)?.archived_at);
  assert.equal(sessions.get(s.id)!.updated_at, before);
  assert.equal(sessions.get(s.id)!.project_id, p.id);
  assert.equal(projects.setArchived(p.id, false)?.archived_at, null);
  assert.equal(sessions.setArchived(s.id, false)?.archived_at, null);
});

test("chats that were never used aren't listed, and are cleared out later", () => {
  const used = sessions.create({ title: "Used", engine: "opencode", model: "m" });
  messages.add({ session_id: used.id, role: "user", content: "hi", model: null, tools_json: null, usage_json: null });
  const empty = sessions.create({ title: "Empty", engine: "opencode", model: "m" });
  // brand new: still listed, so a chat can start
  assert.ok(sessions.listUsed().some((s) => s.id === empty.id));
  assert.ok(!sessions.listUsed(-1000).some((s) => s.id === empty.id));
  assert.ok(sessions.listUsed(-1000).some((s) => s.id === used.id));
  assert.equal(sessions.pruneUnused(-1000) >= 1, true);
  assert.equal(sessions.get(empty.id), undefined);
  assert.ok(sessions.get(used.id));
});
