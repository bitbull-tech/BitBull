import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-archive-"));
process.env.APP_TOKEN = "test-token";
const { projects, sessions } = await import("./db.js");

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
