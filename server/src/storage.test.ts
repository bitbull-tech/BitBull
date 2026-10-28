/**
 * The encryption format is the part that must never be wrong: a bug here is not a failed
 * upload, it is a file that can't be read back. These tests go through the real module,
 * using a local directory as the "bucket".
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const DATA = mkdtempSync(path.join(tmpdir(), "gm-storage-"));
process.env.DATA_DIR = DATA;
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";
process.env.HIPPIUS_ACCESS_KEY = "test-access";
process.env.HIPPIUS_SECRET_KEY = "test-secret";
process.env.HIPPIUS_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const storage = await import("./storage.js");
const reload = () => storage.__test.reloadConfig();
const { storedFiles } = await import("./db.js");

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function file(name: string, bytes: Buffer) {
  const dir = path.join(DATA, "ws");
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, bytes);
  return { dir, rel: name, abs: p };
}

test("the encryption key accepts base64 and hex, and rejects the wrong length", () => {
  const key = storage.newEncryptionKey();
  assert.equal(Buffer.from(key, "base64").length, 32);
  process.env.HIPPIUS_ENCRYPTION_KEY = key;
  reload();
  assert.equal(storage.encryptionKey().length, 32);

  process.env.HIPPIUS_ENCRYPTION_KEY = Buffer.from(key, "base64").toString("hex");
  reload();
  assert.equal(storage.encryptionKey().length, 32);

  process.env.HIPPIUS_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
  reload();
  assert.throws(() => storage.encryptionKey(), /32 bytes/);
  process.env.HIPPIUS_ENCRYPTION_KEY = key;
  reload();
});

test("object keys are a project prefix plus the workspace path, with no traversal", () => {
  assert.equal(storage.objectKey("squadron-202-a1b2", "uploads/3f2a/photo.jpg"), "squadron-202-a1b2/uploads/3f2a/photo.jpg");
  assert.equal(storage.objectKey(null, "uploads/a.txt"), "general/uploads/a.txt");
  // ".." and "." segments are dropped, so a key can never climb out of its prefix
  assert.equal(storage.objectKey("p", "../../etc/passwd"), "p/etc/passwd");
  assert.equal(storage.objectKey("p", "a\\b/./c.txt"), "p/a/b/c.txt");
});

test("the ciphertext length is exactly what is declared to Hippius", () => {
  // Content-Length has to be right up front: too short truncates, too long hangs the PUT
  for (const n of [0, 1, 1024, 1024 * 1024]) assert.equal(storage.encryptedSize(n), storage.HEADER_LEN + n + 16);
});

test("a file survives the round trip, and the checksum is of the plaintext", async () => {
  const bytes = randomBytes(300_000);
  const f = file("photo.jpg", bytes);
  const stored: Record<string, Buffer> = {};

  // Stand in for Hippius: capture what would be PUT, then hand it back on GET
  const sent = await storage.__test.encryptToBuffer(f.abs);
  stored["k"] = sent.body;
  assert.equal(sent.body.length, storage.encryptedSize(bytes.length), "declared length matches the bytes produced");
  assert.equal(sent.sha256, sha(bytes), "the recorded digest is of the plaintext, not the ciphertext");
  assert.notEqual(sent.body.subarray(16, 1016).toString("hex"), bytes.subarray(0, 1000).toString("hex"), "the body is not plaintext");

  const out = path.join(DATA, "restored", "photo.jpg");
  await storage.__test.decryptBuffer(stored["k"], out);
  assert.deepEqual(readFileSync(out), bytes);
});

test("an empty file round-trips too", async () => {
  const f = file("empty.txt", Buffer.alloc(0));
  const sent = await storage.__test.encryptToBuffer(f.abs);
  const out = path.join(DATA, "restored", "empty.txt");
  await storage.__test.decryptBuffer(sent.body, out);
  assert.equal(readFileSync(out).length, 0);
});

test("tampered or truncated data is refused, not silently returned", async () => {
  const f = file("doc.pdf", randomBytes(5000));
  const sent = await storage.__test.encryptToBuffer(f.abs);
  const out = path.join(DATA, "restored", "doc.pdf");

  const flipped = Buffer.from(sent.body);
  flipped[200] ^= 0xff; // one bit in the body
  await assert.rejects(storage.__test.decryptBuffer(flipped, out), /unable to authenticate|bad decrypt|auth/i);

  const truncated = sent.body.subarray(0, sent.body.length - 1);
  await assert.rejects(storage.__test.decryptBuffer(truncated, out), /./);

  const notOurs = Buffer.concat([Buffer.from("XXXX"), sent.body.subarray(4)]);
  await assert.rejects(storage.__test.decryptBuffer(notOurs, out), /not a GM-encrypted file/);
});

test("a different key cannot read it", async () => {
  const f = file("secret.txt", randomBytes(2048));
  const sent = await storage.__test.encryptToBuffer(f.abs);
  const original = process.env.HIPPIUS_ENCRYPTION_KEY;
  process.env.HIPPIUS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  reload();
  await assert.rejects(storage.__test.decryptBuffer(sent.body, path.join(DATA, "restored", "secret.txt")), /unable to authenticate|bad decrypt|auth/i);
  process.env.HIPPIUS_ENCRYPTION_KEY = original;
  reload();
});

test("the ledger records a queued file and survives a re-upload of the same path", () => {
  const row = storedFiles.add({
    id: "one",
    project_id: null,
    project_name: null,
    rel_path: "uploads/a.jpg",
    key: "general/uploads/a.jpg",
    size: 10,
    sha256: null,
    status: "pending",
    error: null,
    created_at: Date.now(),
    stored_at: null,
  });
  storedFiles.update(row.id, { status: "stored", sha256: "abc", stored_at: Date.now() });
  assert.equal(storedFiles.get("one")?.status, "stored");
  assert.equal(storedFiles.counts().stored, 1);

  // Same key again (the user replaced the file): one row, not two
  storedFiles.add({ ...row, id: "two", size: 20, status: "pending", sha256: null, stored_at: null });
  assert.equal(storedFiles.list(null).length, 1);
  assert.equal(storedFiles.byKey("general/uploads/a.jpg")?.id, "two");
  assert.equal(storedFiles.pending().length, 1);
});

test("nothing is mirrored while storage is switched off", () => {
  process.env.STORAGE_MIRROR = "off";
  reload();
  assert.equal(storage.storageEnabled(), false);
  const f = file("ignored.txt", Buffer.from("hi"));
  assert.equal(storage.mirrorFile({ projectId: null, projectDir: null, workspace: f.dir, relPath: f.rel }), null);
  process.env.STORAGE_MIRROR = "uploads";
  reload();
  assert.equal(storage.storageEnabled(), true);
});

test("stored paths from the database can't leave the workspace", async () => {
  const { insideWorkspace } = await import("./storage.js");
  const { symlinkSync } = await import("node:fs");
  const ws = mkdtempSync(path.join(tmpdir(), "gm-ws-"));
  mkdirSync(path.join(ws, "uploads"));
  assert.equal(insideWorkspace(ws, "uploads/a.txt"), path.join(ws, "uploads", "a.txt"));
  assert.equal(insideWorkspace(ws, "new/dir/b.txt"), path.join(ws, "new", "dir", "b.txt"));
  for (const bad of ["../x", "uploads/../../x", "/etc/passwd", "C:/x", "", "a\0b", "."]) {
    assert.throws(() => insideWorkspace(ws, bad), Error, JSON.stringify(bad));
  }
  // a symlinked folder pointing out of the workspace
  symlinkSync(tmpdir(), path.join(ws, "out"));
  assert.throws(() => insideWorkspace(ws, "out/evil.txt"));
  assert.throws(() => insideWorkspace(ws, "out/deeper/evil.txt"));
});
