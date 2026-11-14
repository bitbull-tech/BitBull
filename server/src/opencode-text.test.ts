/**
 * A reply's words must be said once, however the engine delivers them: as "delta" events, inside
 * "updated" events with the whole text so far, or both for the same chunk in either order.
 * (Telegram, 14 Nov 2026: "Yes.Yes. This conversation This conversation shows shows up…")
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-octext-"));
const { textStream } = await import("./engines/opencode.js");

const CHUNKS = ["Yes.", " This conversation", " shows", " up as the Telegram chat in BitB", "ull's sidebar,"];
const WHOLE = CHUNKS.join("");
const upTo = (i: number) => CHUNKS.slice(0, i + 1).join("");

test("deltas only: streamed as they come", () => {
  const s = textStream();
  assert.equal(CHUNKS.map((c) => s.delta("p", c)).join(""), WHOLE);
  // the closing update holds the same text: nothing more to say
  assert.equal(s.updated("p", WHOLE), "");
});

test("whole-text updates only: each sends just what is new", () => {
  const s = textStream();
  assert.equal(s.updated("p", ""), "", "an empty part at the start says nothing");
  assert.equal(CHUNKS.map((_, i) => s.updated("p", upTo(i))).join(""), WHOLE);
  assert.equal(s.updated("p", WHOLE), "", "the same text again adds nothing");
});

test("the same chunk as a delta and inside an update, delta first: said once", () => {
  const s = textStream();
  let out = "";
  CHUNKS.forEach((c, i) => {
    out += s.delta("p", c);
    out += s.updated("p", upTo(i), c);
  });
  assert.equal(out, WHOLE);
});

test("the same chunk as a delta and inside an update, update first: said once", () => {
  const s = textStream();
  let out = "";
  CHUNKS.forEach((c, i) => {
    out += s.updated("p", upTo(i), c);
    out += s.delta("p", c);
  });
  assert.equal(out, WHOLE);
});

test("an update that lags behind the deltas, then catches up: nothing lost, nothing twice", () => {
  const s = textStream();
  let out = s.delta("p", CHUNKS[0]) + s.delta("p", CHUNKS[1]) + s.delta("p", CHUNKS[2]);
  out += s.updated("p", upTo(1)); // behind what was already sent
  out += s.delta("p", CHUNKS[3]); // ignored from here: the whole text is being followed
  out += s.updated("p", upTo(3));
  out += s.updated("p", WHOLE);
  assert.equal(out, WHOLE);
});

test("an update with only a delta (older engines) still streams, and parts are counted apart", () => {
  const s = textStream();
  assert.equal(s.updated("a", undefined, "one"), "one");
  assert.equal(s.updated("a", "", " two"), " two");
  assert.equal(s.delta("b", "other part"), "other part");
  assert.equal(s.sent("a"), 7);
  assert.equal(s.sent("b"), 10);
  assert.equal(s.sent("never"), 0);
});
