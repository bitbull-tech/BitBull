import assert from "node:assert/strict";
import { test } from "node:test";
import { headerSafe } from "./ditto.js";

test("headerSafe: chat titles survive as HTTP header values", () => {
  // the bug: auto-titles end in U+2026 and HTTP headers are ByteStrings (<= 0xFF)
  assert.equal(headerSafe("Review this git repo and add it to this proje…"), "Review this git repo and add it to this proje...");
  assert.equal(headerSafe("BitBull Coding Agent · QA swarm"), "BitBull Coding Agent - QA swarm");
  assert.equal(headerSafe("Tom’s “plan”"), "Tom's \"plan\"");
  assert.equal(headerSafe("émoji 🎉 and 日本語"), "moji and");
  assert.equal(headerSafe("line\r\nbreak\ttab"), "line break tab");
  assert.equal(headerSafe("x".repeat(200)).length, 120);
  assert.equal(headerSafe("…"), "...");
  assert.equal(headerSafe("🎉"), "");
  for (const s of ["Review…", "a · b", "🎉 x", " lead"]) {
    for (const ch of headerSafe(s)) assert.ok(ch.codePointAt(0)! <= 0x7e, `${JSON.stringify(s)} -> non-ASCII`);
  }
});
