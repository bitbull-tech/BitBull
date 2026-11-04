import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The vault: keys entered in the Settings UI, encrypted at rest (AES-256-GCM) with a key the
 * server never stores. The key lives on the owner's PC (the link helper keeps it under Windows
 * DPAPI) and the browser hands it over at unlock; the server keeps it, and the decrypted
 * values, only in memory. So `settings.local.json`, which the agent's shell can read because
 * it shares the server's uid, holds no secrets any more; the vault file is ciphertext to it.
 *
 * Locked (no key yet, or after `lock()`): the vault contributes nothing and .env applies. The
 * SayGM key in .env is what the stack boots on; the vault is for what the owner adds later.
 *
 * No imports from config.ts: config reads `vaultValues()` while it is being evaluated, so this
 * module must stand on its own.
 */

/** Which editable settings are secrets and belong here rather than in settings.local.json. */
export const VAULT_KEYS = new Set([
  "SAYGM_API_KEY",
  "DITTO_API_KEY",
  "GITHUB_TOKEN",
  "ATLAS_API_KEY",
  "FOUR04_API_KEY",
  "TAOSTATS_API_KEY",
  "HIPPIUS_ACCESS_KEY",
  "HIPPIUS_SECRET_KEY",
  "HIPPIUS_ENCRYPTION_KEY",
]);

interface FileShape {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

let file = "";
let key: Buffer | null = null;
let values: Record<string, string> = {};

/** Point the vault at its file (DATA_DIR/vault.json). Called once by config. */
export function configureVault(path: string) {
  file = path;
}
export const vaultFile = () => file;
export const vaultExists = () => !!file && existsSync(file);
export const vaultUnlocked = () => key !== null;

/** Decrypted values while unlocked, {} while locked. Read by config on every reload. */
export function vaultValues(): Record<string, string> {
  return key ? { ...values } : {};
}
export function vaultKeys(): string[] {
  return key ? Object.keys(values).sort() : [];
}

function parseKey(hex: string): Buffer {
  const k = /^[0-9a-f]{64}$/i.test(hex.trim()) ? Buffer.from(hex.trim(), "hex") : Buffer.alloc(0);
  if (k.length !== 32) throw new Error("vault key must be 32 bytes as 64 hex characters");
  return k;
}

function decrypt(k: Buffer, f: FileShape): Record<string, string> {
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(f.iv, "base64"));
  d.setAuthTag(Buffer.from(f.tag, "base64"));
  const plain = Buffer.concat([d.update(Buffer.from(f.data, "base64")), d.final()]).toString("utf8");
  const obj = JSON.parse(plain);
  if (!obj || typeof obj !== "object") throw new Error("vault content is not an object");
  const out: Record<string, string> = {};
  for (const [a, b] of Object.entries(obj)) if (typeof b === "string" && VAULT_KEYS.has(a)) out[a] = b;
  return out;
}

function persist() {
  if (!key || !file) return;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(values), "utf8"), c.final()]);
  const f: FileShape = { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  mkdirSync(require_dir(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(f) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* filesystem without modes */
  }
}
const require_dir = (p: string) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) || 1);

/**
 * Unlock with the owner's key. With an existing file the key must open it (GCM authenticates,
 * so a wrong key fails cleanly); with none, this key becomes the vault's key and an empty
 * vault is written. Returns the number of secrets now available.
 */
export function unlockVault(keyHex: string): number {
  const k = parseKey(keyHex);
  if (key && timingSafeEqual(key, k)) return Object.keys(values).length;
  if (vaultExists()) {
    const f = JSON.parse(readFileSync(file, "utf8")) as FileShape;
    if (f?.v !== 1) throw new Error("unknown vault file version");
    values = decrypt(k, f); // throws on a wrong key
    key = k;
  } else {
    key = k;
    values = {};
    persist();
  }
  return Object.keys(values).length;
}

export function lockVault() {
  key = null;
  values = {};
}

/** Set (or with null/"" remove) one secret; persisted at once. Only while unlocked. */
export function vaultSet(name: string, value: string | null) {
  if (!key) throw new Error("the vault is locked");
  if (!VAULT_KEYS.has(name)) throw new Error(`${name} is not a vault setting`);
  if (value === null || value.trim() === "") delete values[name];
  else values[name] = value.trim();
  persist();
}
