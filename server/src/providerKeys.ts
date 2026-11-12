/**
 * Provider keys, kept in Ditto (docs/ROUTER.md → Provider keys).
 *
 * A user pastes a GM, Engy, Instant, OpenRouter, OpenAI, Anthropic or Google key into Settings and
 * presses Save; BitBull hands it to the Ditto CLI (`heyditto keys set`), which saves it to their
 * Ditto account. BitBull never stores it: Ditto is the key manager, and Router endpoints bill to it.
 *
 * The CLI runs with BitBull's Ditto account key in its environment and nothing else of BitBull's,
 * the provider key on stdin (never argv), and a fresh private config folder per run. Writing needs
 * a Connect approved for key access (device intent "keys"); an older Connect gets
 * `provider_keys_not_granted`, and the UI asks for a reconnect.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

export type ProviderKey = { id: string; provider: string; label?: string; configured: boolean; enabled: boolean };
export type KeyProvider = { id: string; displayName: string; docsUrl: string; keyPrefixHints?: string[] };
export type KeyValidation = { ok: boolean; status?: number; error?: string; checkedAt: string };

/** A refusal from the CLI or Ditto, with the code the UI acts on. */
export class ProviderKeyError extends Error {
  constructor(public code: string, message: string, public status = 502) {
    super(message);
  }
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/; // never a flag: argv to the CLI
const LABEL_MAX = 64; // Ditto's limit on a key's name
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Ditto CLI in the image (Dockerfile); `DITTO_CLI` overrides it. Also runs ditto_review (mcp.ts). */
export const cli = () => process.env.DITTO_CLI?.trim() || "heyditto";

/**
 * What every run of the Ditto CLI gets: BitBull's Ditto account key and none of its other secrets,
 * Ditto's API origin, the image's version (never a self-update), and the sandbox's egress proxy.
 */
export function dittoCliEnv(configDir: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    DITTO_CONFIG_DIR: configDir,
    DITTO_API_KEY: config.ditto.apiKey,
    DITTO_API_BASE: new URL(config.ditto.mcpUrl).origin,
    // the version in the image, never a self-update
    DITTO_CLI_AUTO_UPDATE: "0",
    DITTO_CLI_PINNED: "1",
    NO_COLOR: "1",
    // in the sandbox the server reaches Ditto through the egress proxy
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
    // Node's fetch only honours HTTPS_PROXY with this (docker-compose.yml sets it for the server)
    ...(process.env.NODE_USE_ENV_PROXY ? { NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY } : {}),
  };
}

/** Run `heyditto <args> --output json`; resolves to its JSON or throws its `{error}`. */
export async function heyditto<T>(args: string[], stdin = ""): Promise<T> {
  if (!config.ditto.apiKey) throw new ProviderKeyError("not_connected", "Connect Ditto first.", 400);
  const home = mkdtempSync(path.join(os.tmpdir(), "bitbull-heyditto-"));
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(cli(), [...args, "--output", "json"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...dittoCliEnv(home), HOME: home },
        timeout: 45_000,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (err: NodeJS.ErrnoException) =>
        reject(err.code === "ENOENT" ? new ProviderKeyError("cli_missing", "The Ditto CLI (heyditto) is not installed here; deploy a BitBull build that includes it.") : err),
      );
      child.on("close", (exit) => resolve({ code: exit, stdout: out, stderr: err }));
      child.stdin.end(stdin);
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // not JSON: a CLI too old for `keys`, or a crash; stderr never carries the provider key
      const unknown = /unknown command 'keys'/.test(stderr);
      throw new ProviderKeyError(
        unknown ? "cli_outdated" : "cli_failed",
        unknown ? "This BitBull's Ditto CLI is too old for provider keys. Update BitBull." : `The Ditto CLI failed: ${stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${code}`}`,
      );
    }
    const error = (parsed as { error?: { code?: string; message?: string; status?: number } }).error;
    if (code !== 0 || error) {
      throw new ProviderKeyError(error?.code ?? "cli_failed", error?.message ?? `The Ditto CLI exited with ${code}`, error?.status && error.status < 500 ? error.status : 502);
    }
    return parsed as T;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export const listProviderKeys = () => heyditto<{ keys: ProviderKey[] }>(["keys", "list"]);
export const listKeyProviders = () => heyditto<{ providers: KeyProvider[] }>(["keys", "providers"]);

/**
 * Save (or replace) a key in Ditto, and report the provider's check. A label names the key, so one
 * provider can hold several; the same provider and label replaces that key, no label the original.
 */
export async function saveProviderKey(provider: string, key: string, label = "") {
  if (!PROVIDER_ID.test(provider)) throw new ProviderKeyError("provider_not_supported", "Pick a provider from the list.", 400);
  if (!key.trim()) throw new ProviderKeyError("empty_key", "Paste a key first.", 400);
  const name = label.trim();
  if (name.length > LABEL_MAX || /\p{Cc}/u.test(name)) throw new ProviderKeyError("bad_label", `Use a name of up to ${LABEL_MAX} characters.`, 400);
  // `--label=<name>`, one argv entry, so a name like "--help" is never read as a flag
  return heyditto<{ key: ProviderKey; validation?: KeyValidation }>(["keys", "set", provider, ...(name ? [`--label=${name}`] : [])], key.trim());
}

export async function setProviderKeyEnabled(id: string, enabled: boolean) {
  if (!KEY_ID.test(id)) throw new ProviderKeyError("key_not_found", "No such key.", 404);
  return heyditto<{ key: ProviderKey }>(["keys", enabled ? "enable" : "disable", id]);
}

export async function removeProviderKey(id: string) {
  if (!KEY_ID.test(id)) throw new ProviderKeyError("key_not_found", "No such key.", 404);
  await heyditto(["keys", "remove", id, "--yes"]);
}

/** BitBull's own SayGM key, saved to Ditto as the "gm" key: the value never reaches the UI. */
export async function copySaygmKey() {
  if (!config.saygm.apiKey) throw new ProviderKeyError("empty_key", "BitBull has no SayGM key to copy.", 400);
  return saveProviderKey("gm", config.saygm.apiKey);
}
