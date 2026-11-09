import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { test } from "node:test";
import { collect, disposition, insideReal, outputsDuring, zip } from "./outputs.js";

function workspace() {
  const ws = mkdtempSync(path.join(tmpdir(), "bitbull-outputs-"));
  const at = (rel: string, body: string, ms: number) => {
    const abs = path.join(ws, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    utimesSync(abs, ms / 1000, ms / 1000);
  };
  return { ws, at };
}

test("a reply's files are the ones written while its turn ran, not engine state or dependencies", () => {
  const { ws, at } = workspace();
  const t0 = Date.UTC(2026, 10, 9, 12);
  at("cartoon-dog-voice/voice-brief.md", "# brief", t0 + 5_000);
  at("old.txt", "before", t0 - 60_000);
  at("node_modules/x/index.js", "dep", t0 + 5_000);
  at(".opencode/state.json", "{}", t0 + 5_000);
  at("later.txt", "after", t0 + 120_000);
  const files = outputsDuring(ws, [{ start: t0, end: t0 + 30_000 }]);
  assert.deepEqual(files.map((f) => f.path), ["cartoon-dog-voice/voice-brief.md"]);
  assert.equal(files[0].turn.start, t0);
});

test("downloads stay inside the workspace", () => {
  const { ws, at } = workspace();
  at("a/b.txt", "hi", Date.now());
  assert.ok(insideReal(ws, "a/b.txt"));
  const outside = mkdtempSync(path.join(tmpdir(), "bitbull-outside-"));
  symlinkSync(outside, path.join(ws, "escape"));
  assert.equal(insideReal(ws, "escape"), null);
  assert.equal(insideReal(ws, "nope"), null);
});

test("folders and several files come down as a zip any unzip can read", () => {
  const { ws, at } = workspace();
  at("art/dog.svg", "<svg/>".repeat(200), Date.now());
  at("art/notes/readme.md", "notes", Date.now());
  at("art/.git/HEAD", "ref", Date.now());
  const files = collect(ws, ["art"]);
  assert.deepEqual(files.map((f) => f.name).sort(), ["art/dog.svg", "art/notes/readme.md"]);
  const z = zip(files);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
  assert.equal(z.readUInt16LE(z.length - 22 + 10), 2);
  // first entry round-trips
  const method = z.readUInt16LE(8);
  const csize = z.readUInt32LE(18);
  const nlen = z.readUInt16LE(26);
  const body = z.subarray(30 + nlen, 30 + nlen + csize);
  const data = method === 8 ? inflateRawSync(body) : body;
  assert.ok(data.toString().startsWith("<svg/>") || data.toString() === "notes");
  assert.match(disposition("Dog brief “v2”.md"), /filename\*=UTF-8''Dog%20brief/);
});
