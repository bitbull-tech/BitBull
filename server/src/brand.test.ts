import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// config reads DATA_DIR at import time
const dir = mkdtempSync(path.join(tmpdir(), "bitbull-brand-"));
process.env.DATA_DIR = dir;
const { parseScheme, saveScheme, brand } = await import("./brand.js");
const file = path.join(dir, "brand.json");

test("a scheme keeps only #rrggbb background and sidebar colours", () => {
  const s = parseScheme({
    light: { bg: "#ABCDEF", side: "red", extra: "#000000" },
    dark: { bg: "#123456; --text: x", side: "#0a0a0a" },
  });
  assert.deepEqual(s, { light: { bg: "#abcdef" }, dark: { side: "#0a0a0a" } });
  assert.deepEqual(parseScheme("nonsense"), { light: {}, dark: {} });
});

test("saving a scheme keeps the rest of brand.json, and an empty one removes it", () => {
  writeFileSync(file, JSON.stringify({ name: "Acme", tokens: { light: { accent: "#ff0000" } } }));
  const b = saveScheme({ light: { bg: "#f3f5f8", side: "#1e293b" }, dark: {} });
  assert.equal(b.name, "Acme");
  assert.deepEqual(b.scheme.light, { bg: "#f3f5f8", side: "#1e293b" });
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.tokens.light.accent, "#ff0000");
  saveScheme({});
  assert.equal("scheme" in JSON.parse(readFileSync(file, "utf8")), false);
  assert.deepEqual(brand().scheme, { light: {}, dark: {} });
});

test("a brand.json that isn't valid JSON is left alone", () => {
  writeFileSync(file, "{ not json");
  assert.throws(() => saveScheme({ light: { bg: "#ffffff" } }), /valid JSON/);
  assert.equal(readFileSync(file, "utf8"), "{ not json");
});

test("a brand.json that is a link is never written through", (t) => {
  const target = path.join(dir, "elsewhere.json");
  writeFileSync(target, "{}");
  rmSync(file, { force: true });
  try {
    symlinkSync(target, file);
  } catch {
    return t.skip("can't make a symlink here (Windows without Developer Mode or admin)");
  }
  assert.throws(() => saveScheme({ light: { bg: "#ffffff" } }), /not a plain file/);
  assert.equal(readFileSync(target, "utf8"), "{}");
});
