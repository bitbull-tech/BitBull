/**
 * Compatibility checks: the gateway responses BitBull parses are checked for the fields it reads,
 * deprecation headers become notices, and published notices are trimmed, typed and dropped once
 * this build has the fix.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-compat-"));
const { checkHeaders, checkLatest, checkMcpCatalog, checkRouterModels, checkSaygmModels, parsePublished } = await import("./compat.js");

const ids = (n: Array<{ id: string }>) => n.map((x) => x.id);

test("SayGM's model list: fine as it is today, loud when its shape changes", () => {
  const ok = { data: [{ id: "claude-sonnet-5", api_shapes: ["messages"] }, { id: "kimi-k3", api_shapes: ["chat.completions"] }] };
  assert.deepEqual(checkSaygmModels(ok, { model: "claude-sonnet-5", small: "kimi-k3" }), []);
  assert.deepEqual(ids(checkSaygmModels({ models: [] }, { model: "x", small: "" })), ["saygm-models-shape"]);
  assert.equal(checkSaygmModels("<html>", { model: "x", small: "" })[0].level, "breaking");
  assert.deepEqual(ids(checkSaygmModels({ data: [{ name: "no id" }] }, { model: "", small: "" })), ["saygm-models-ids"]);
  // every model lost api_shapes: BitBull is guessing
  assert.deepEqual(ids(checkSaygmModels({ data: [{ id: "a" }, { id: "b" }] }, { model: "a", small: "b" })), ["saygm-api-shapes"]);
  // a retired default; a Router default is not SayGM's to list
  assert.deepEqual(ids(checkSaygmModels(ok, { model: "gone-model", small: "kimi-k3" })), ["saygm-missing-gone-model"]);
  assert.deepEqual(checkSaygmModels(ok, { model: "ditto-router/bitbull", small: "kimi-k3" }), []);
});

test("Ditto Router's model list and tool catalog", () => {
  const ok = { data: [{ id: "bitbull", ditto: { record_enabled: true, recall_enabled: true, tools: ["*"] } }, { id: "kimi-k3" }] };
  assert.deepEqual(checkRouterModels(ok, { model: "claude-sonnet-5" }), []);
  assert.deepEqual(checkRouterModels(ok, { model: "ditto-router/bitbull" }), []);
  assert.deepEqual(ids(checkRouterModels(ok, { model: "ditto-router/retired" })), ["router-missing-retired"]);
  assert.deepEqual(ids(checkRouterModels({ data: [{ id: "bitbull" }] }, { model: "" })), ["router-endpoint-block"]);
  assert.deepEqual(ids(checkRouterModels({ nope: 1 }, { model: "" })), ["router-models-shape"]);
  assert.deepEqual(checkMcpCatalog({ servers: [] }), []);
  assert.deepEqual(ids(checkMcpCatalog({ tools: [] })), ["router-mcp-shape"]);
});

test("deprecation headers become one notice", () => {
  assert.deepEqual(checkHeaders("saygm", "model list", new Headers({ "content-type": "application/json" })), []);
  const [n] = checkHeaders("ditto", "Router model list", new Headers({ deprecation: "true", sunset: "Wed, 01 Apr 2027 00:00:00 GMT" }));
  assert.equal(n.id, "ditto-deprecation-Router model list");
  assert.match(n.detail, /deprecated; switched off on Wed, 01 Apr 2027/);
  assert.equal(n.action, "update");
});

test("published notices: typed, trimmed, and gone once this build has the fix", () => {
  const body = {
    notices: [
      { id: "saygm-v2", level: "breaking", source: "saygm", title: "SayGM v2 API", detail: "Old API off on 1 March.", fixedIn: "2026-12-01T00:00:00Z" },
      { id: "fyi", level: "info", source: "ditto", title: "Heads up", detail: "x".repeat(2000) },
      { id: "<script>", level: "shout", source: "evil", title: "Odd\u0000 one" },
      { title: "no id" },
      "junk",
    ],
  };
  const old = parsePublished(body, { commit: "abc", committed: "2026-11-10T00:00:00Z" });
  assert.deepEqual(ids(old), ["published-saygm-v2", "published-fyi", "published-script"]);
  assert.equal(old[0].action, "update");
  assert.equal(old[1].detail.length, 600);
  assert.equal(old[1].action, undefined);
  assert.deepEqual([old[2].level, old[2].source, old[2].title], ["warn", "bitbull", "Odd one"]);
  // built after the fix: that notice is gone; an unknown build date keeps it
  assert.deepEqual(ids(parsePublished(body, { commit: "def", committed: "2026-12-02T00:00:00Z" })), ["published-fyi", "published-script"]);
  assert.equal(parsePublished(body, {}).length, 3);
  assert.deepEqual(parsePublished({ nope: 1 }, {}), []);
});

test("a newer BitBull: only when main is ahead of this build", () => {
  const main = { sha: "ffff0000aaaa1111", commit: { committer: { date: "2026-11-20T00:00:00Z" } } };
  assert.deepEqual(ids(checkLatest(main, { commit: "abc1234", committed: "2026-11-10T00:00:00Z" })), ["update-ffff0000aa"]);
  assert.deepEqual(checkLatest(main, { commit: "ffff0000", committed: "2026-11-20T00:00:00Z" }), []);
  // a local build newer than main, or a build that doesn't know its commit
  assert.deepEqual(checkLatest(main, { commit: "abc1234", committed: "2026-11-25T00:00:00Z" }), []);
  assert.deepEqual(checkLatest(main, {}), []);
});
