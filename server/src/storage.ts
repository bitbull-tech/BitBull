/**
 * Off-machine storage on Hippius (S3-compatible, decentralised).
 *
 * What goes where: **Hippius holds the bytes, Ditto holds what they are.** Every file the
 * user uploads is encrypted here and mirrored to one bucket under a per-project prefix,
 * recorded in `stored_files`, and described in a Ditto memory so "find the photo of
 * Grandad's squadron" can search for it and get back a key.
 *
 * Why BitBob holds the only key: Hippius sub-tokens scope to a *bucket*, read-only or
 * read-write — there is no IAM, no STS and no per-prefix policy. Prefix isolation can
 * therefore only be enforced by whoever holds the credential, so no user ever gets one.
 * When multi-user arrives, access is a row in BitBob's own database and nothing here changes.
 *
 * Everything is encrypted before it leaves the machine (AES-256-GCM), because Hippius's
 * own at-rest encryption doesn't say who can read a chunk on a storage miner.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { S3Client, GetObjectCommand, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { config, configVersion, reloadConfig } from "./config.js";
import { record } from "./activity.js";
import { indexFile } from "./ditto.js";
import { storedFiles, type StoredFileRow } from "./db.js";

/** File header: magic, version, then the GCM nonce. The 16-byte tag is appended at the end. */
const MAGIC = Buffer.from("GMS1", "ascii");
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + IV_LEN;
/** Ciphertext length for a given plaintext length: header + body + tag. */
export const encryptedSize = (plain: number) => HEADER_LEN + plain + TAG_LEN;

export const storageEnabled = () =>
  config.storage.mirror !== "off" && !!config.storage.accessKey && !!config.storage.secretKey && !!config.storage.encryptionKey;

/** 32 bytes from the configured base64/hex key. Throws if it isn't the right size. */
export function encryptionKey(): Buffer {
  const raw = config.storage.encryptionKey.trim();
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("HIPPIUS_ENCRYPTION_KEY must be 32 bytes (base64 or hex)");
  return buf;
}

/** A fresh key for a first-time setup. Shown once, then stored in settings.local.json. */
export const newEncryptionKey = () => randomBytes(32).toString("base64");

let client: S3Client | null = null;
let clientVersion = -1;
function s3(): S3Client {
  if (client && clientVersion === configVersion) return client;
  client?.destroy();
  clientVersion = configVersion;
  client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    // Hippius addresses buckets by path, not by subdomain
    forcePathStyle: true,
    /**
     * The SDK defaults to adding a CRC32 trailer, which turns every PUT into an
     * `aws-chunked` body with no Content-Length and a STREAMING-UNSIGNED-PAYLOAD-TRAILER
     * signature. That is an AWS extension; Hippius's compatibility matrix doesn't claim it,
     * and a store that doesn't understand the framing would save the chunk headers as part
     * of the object. WHEN_REQUIRED gives a plain Content-Length PUT instead.
     */
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: config.storage.accessKey, secretAccessKey: config.storage.secretKey },
  });
  return client;
}

/** Called when settings change, so a new key or endpoint takes effect without a restart. */
export function resetStorage() {
  client?.destroy();
  client = null;
  clientVersion = -1;
}

/**
 * Object key for a file: `<project-slug>/<path within the workspace>`. The prefix is what
 * a future per-user or per-project grant will be expressed in terms of, so it never
 * contains a chat id or anything else that changes.
 */
export function objectKey(projectDir: string | null, relPath: string) {
  const clean = relPath.split(/[\\/]+/).filter((s) => s && s !== "." && s !== "..").join("/");
  return `${projectDir ?? "general"}/${clean}`;
}

// ---------- encryption ----------

/** Encrypt a file into a stream of exactly `encryptedSize(size)` bytes, hashing as it goes. */
function encryptStream(file: string, key: Buffer) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const hash = createHash("sha256");
  const out = new PassThrough();
  out.write(Buffer.concat([MAGIC, iv]));

  const done = (async () => {
    const source = createReadStream(file);
    source.on("data", (chunk) => hash.update(chunk));
    await pipeline(source, cipher, out, { end: false });
    out.end(cipher.getAuthTag()); // the tag is only known once the body is finished
    return hash.digest("hex");
  })();

  return { body: out, sha256: done };
}

/**
 * Decrypt a downloaded file to `dest`. The tag lives at the end, but the cipher needs it
 * before it will produce the final block, so it is read first and the body streamed after.
 */
async function decryptFile(src: string, dest: string, key: Buffer) {
  const size = (await stat(src)).size;
  if (size < HEADER_LEN + TAG_LEN) throw new Error("stored file is too short to be valid");
  const fh = await open(src, "r");
  try {
    const header = Buffer.alloc(HEADER_LEN);
    await fh.read(header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("not a BitBob-encrypted file");
    const tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);

    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    mkdirSync(path.dirname(dest), { recursive: true });
    // An altered or truncated file fails here, in decipher.final(), rather than silently.
    // A zero-byte file has no body at all, but its tag is still checked.
    const bodyLength = size - HEADER_LEN - TAG_LEN;
    const body = bodyLength > 0 ? createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }) : Readable.from([]);
    await pipeline(body, decipher, createWriteStream(dest));
  } finally {
    await fh.close();
  }
}

// ---------- the queue ----------

interface Job {
  row: StoredFileRow;
  absPath: string;
  attempt: number;
}
const queue: Job[] = [];
let working = false;
const RETRIES = [2000, 15000, 60000];

/**
 * Mirror a file that has landed in a workspace. Returns immediately: uploading must never
 * slow down an upload the user is watching, or a turn the agent is running.
 */
export function mirrorFile(input: {
  projectId: string | null;
  projectDir: string | null;
  projectName?: string;
  workspace: string;
  relPath: string;
  description?: string;
}) {
  if (!storageEnabled()) return null;
  const absPath = path.join(input.workspace, input.relPath);
  if (!existsSync(absPath)) return null;
  const size = statSync(absPath).size;
  if (size > config.storage.maxFileMb * 1024 * 1024) {
    record({ level: "warn", source: "storage", message: `Not stored: ${input.relPath} is over ${config.storage.maxFileMb} MB` });
    return null;
  }
  const row = storedFiles.add({
    id: randomUUID(),
    project_id: input.projectId,
    project_name: input.projectName ?? null,
    rel_path: input.relPath,
    key: objectKey(input.projectDir, input.relPath),
    size,
    sha256: null,
    status: "pending",
    error: null,
    created_at: Date.now(),
    stored_at: null,
  });
  queue.push({ row, absPath, attempt: 0 });
  void drain();
  return row;
}

async function drain() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const job = queue.shift()!;
      try {
        await upload(job);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (job.attempt < RETRIES.length) {
          const wait = RETRIES[job.attempt];
          job.attempt++;
          setTimeout(() => {
            queue.push(job);
            void drain();
          }, wait).unref?.();
        } else {
          storedFiles.update(job.row.id, { status: "failed", error: message });
          record({ level: "error", source: "storage", message: `Could not store ${job.row.rel_path}: ${message}` });
        }
      }
    }
  } finally {
    working = false;
  }
}

async function upload(job: Job) {
  const key = encryptionKey();
  const size = statSync(job.absPath).size;
  const { body, sha256 } = encryptStream(job.absPath, key);
  // If the read fails, the upload below fails too; make sure the hash promise's rejection is
  // observed either way (an unobserved one would take the whole server down).
  sha256.catch(() => {});
  await s3().send(
    new PutObjectCommand({
      Bucket: config.storage.bucket,
      Key: job.row.key,
      Body: body,
      // Hippius needs the length up front; GCM adds only the header and tag
      ContentLength: encryptedSize(size),
      ContentType: "application/octet-stream",
      Metadata: { "bitbob-name": path.basename(job.row.rel_path).slice(0, 200), "bitbob-size": String(size) },
    }),
  );
  const digest = await sha256;
  storedFiles.update(job.row.id, { status: "stored", sha256: digest, stored_at: Date.now(), error: null });
  record({
    level: "info",
    source: "storage",
    message: `Stored ${job.row.rel_path} (${(size / 1024 / 1024).toFixed(1)} MB)`,
    detail: `hippius:${config.storage.bucket}/${job.row.key}\nsha256 ${digest}`,
  });
  // Fire and forget: the index is useful, but a Ditto outage must not fail the upload
  void indexFile({
    name: path.basename(job.row.rel_path),
    project: job.row.project_name ?? undefined,
    relPath: job.row.rel_path,
    key: job.row.key,
    bucket: config.storage.bucket,
    sha256: digest,
    size,
  }).catch(() => {});
}

/** Re-queue anything left pending by a restart. */
export function resumeMirror(workspaceOf: (projectId: string | null) => string | null) {
  if (!storageEnabled()) return 0;
  const pending = storedFiles.pending();
  let queued = 0;
  for (const row of pending) {
    const ws = workspaceOf(row.project_id);
    if (!ws) continue;
    let absPath: string;
    try {
      absPath = insideWorkspace(ws, row.rel_path);
    } catch (e) {
      storedFiles.update(row.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!existsSync(absPath)) {
      storedFiles.update(row.id, { status: "failed", error: "the local file is gone" });
      continue;
    }
    queue.push({ row, absPath, attempt: 0 });
    queued++;
  }
  if (queued) {
    record({ level: "info", source: "storage", message: `Resuming ${queued} upload(s) to Hippius` });
    void drain();
  }
  return queued;
}

// ---------- restore ----------

/**
 * rel_path comes from agent.db, which the agent's shell can write (GAPS #11), so it is never
 * trusted: it must be a plain relative path that stays inside the workspace, including after
 * resolving symlinks in the folders on the way.
 */
export function insideWorkspace(workspace: string, rel: string): string {
  if (!rel || typeof rel !== "string" || rel.includes("\0") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`refusing an unsafe stored path: ${JSON.stringify(rel)}`);
  }
  const root = path.resolve(workspace);
  const dest = path.resolve(root, rel);
  if (!dest.startsWith(root + path.sep)) throw new Error(`refusing a stored path outside the workspace: ${JSON.stringify(rel)}`);
  // the nearest existing folder must also resolve inside the workspace (no symlinked folders out)
  let dir = path.dirname(dest);
  while (!existsSync(dir) && dir.startsWith(root + path.sep)) dir = path.dirname(dir);
  const realRoot = realpathSync(root);
  const realDir = realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error(`refusing a stored path that leaves the workspace through a link: ${JSON.stringify(rel)}`);
  // and the file itself must not be a link planted where the restore will write
  try {
    if (lstatSync(dest).isSymbolicLink()) throw new Error(`refusing to restore over a symlink: ${JSON.stringify(rel)}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return dest;
}

/**
 * Pull a stored file back into a workspace and verify it. The SHA-256 is of the *plaintext*,
 * so a match proves the round trip through Hippius and the encryption were both clean.
 */
export async function restoreFile(row: StoredFileRow, workspace: string): Promise<{ path: string; verified: boolean }> {
  if (!storageEnabled()) throw new Error("Hippius storage is not configured");
  const key = encryptionKey();
  const tmpDir = path.join(config.dataDir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `restore-${randomUUID()}`);
  const dest = insideWorkspace(workspace, row.rel_path);
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: config.storage.bucket, Key: row.key }));
    if (!res.Body) throw new Error("empty response from Hippius");
    await pipeline(res.Body as Readable, createWriteStream(tmp));
    await decryptFile(tmp, dest, key);
    const hash = createHash("sha256");
    await pipeline(createReadStream(dest), hash);
    const verified = !row.sha256 || hash.digest("hex") === row.sha256;
    record({
      level: verified ? "info" : "warn",
      source: "storage",
      message: verified ? `Restored ${row.rel_path}` : `Restored ${row.rel_path}, but the checksum does not match`,
    });
    return { path: dest, verified };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Remove an object. Used when a mirrored file is deleted locally and the user asks. */
export async function removeStored(row: StoredFileRow) {
  await s3().send(new DeleteObjectCommand({ Bucket: config.storage.bucket, Key: row.key }));
  storedFiles.remove(row.id);
}

/**
 * The real encrypt/decrypt paths, exposed for storage.test.ts so the tests exercise what
 * runs in production rather than a copy of it. Not used anywhere else.
 */
export const __test = {
  reloadConfig,
  async encryptToBuffer(file: string): Promise<{ body: Buffer; sha256: string }> {
    const { body, sha256 } = encryptStream(file, encryptionKey());
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    return { body: Buffer.concat(chunks), sha256: await sha256 };
  },
  async decryptBuffer(buf: Buffer, dest: string) {
    const tmp = path.join(config.dataDir, "tmp", `test-${randomUUID()}`);
    mkdirSync(path.dirname(tmp), { recursive: true });
    await pipeline(Readable.from(buf), createWriteStream(tmp));
    try {
      await decryptFile(tmp, dest, encryptionKey());
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  },
};

// ---------- status ----------

export async function probeStorage() {
  if (config.storage.mirror === "off") return { ok: false, configured: false, detail: "Off (STORAGE_MIRROR=off)" };
  if (!config.storage.accessKey || !config.storage.secretKey) return { ok: false, configured: false, detail: "No Hippius sub-token set" };
  if (!config.storage.encryptionKey) return { ok: false, configured: false, detail: "No encryption key set" };
  try {
    encryptionKey();
  } catch (e) {
    return { ok: false, configured: true, detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    const started = Date.now();
    await s3().send(new HeadBucketCommand({ Bucket: config.storage.bucket }));
    const counts = storedFiles.counts();
    return {
      ok: true,
      configured: true,
      detail: `${config.storage.bucket} · ${counts.stored} file${counts.stored === 1 ? "" : "s"} stored${counts.pending ? ` · ${counts.pending} queued` : ""}${
        counts.failed ? ` · ${counts.failed} failed` : ""
      } · ${Date.now() - started} ms`,
      ...counts,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      configured: true,
      detail: /NoSuchBucket|NotFound|404/.test(message)
        ? `Bucket "${config.storage.bucket}" not found — create it in the Hippius console, or check HIPPIUS_BUCKET`
        : /403|AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/.test(message)
          ? `Rejected by Hippius (${message}) — check the sub-token has Object Read & Write on this bucket`
          : message,
    };
  }
}
