import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureVault, vaultValues } from "./vault.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root (server/src or server/dist -> ../..) */
export const ROOT = path.resolve(here, "..", "..");

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required env var ${name}`);
    return fallback;
  }
  return v;
}

const bool = (v: string) => ["1", "true", "yes", "on"].includes(v.toLowerCase());

export type EngineId = "opencode" | "claude";

/* ---------- settings saved from the UI ----------
 * .env is the base. Keys edited in Settings → Configuration are saved to
 * <DATA_DIR>/settings.local.json (mode 600, never in git) and win over .env.
 * They're applied to process.env before the config below is built, and again live on save.
 */
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
/**
 * The only keys the UI may set, and the only keys ever read from settings.local.json.
 * That file lives in DATA_DIR, which the agent's shell can write, so anything not listed here
 * is ignored (and reported) rather than applied: APP_TOKEN, sandbox/proxy settings, paths,
 * and service URLs stay .env-only. URLs are excluded on purpose: changing where a key is sent
 * is as good as reading the key.
 */
export const EDITABLE: Record<string, { options?: string[] }> = {
  SAYGM_API_KEY: {},
  DITTO_API_KEY: {},
  DITTO_ARCHIVE: { options: ["turn", "off"] },
  DEFAULT_ENGINE: { options: ["opencode", "claude"] },
  DEFAULT_MODEL: {},
  SMALL_MODEL: {},
  SUBAGENT_MODEL: {},
  OWNER_NAME: {},
  GITHUB_TOKEN: {},
  GIT_USER_NAME: {},
  GIT_USER_EMAIL: {},
  ATLAS_API_KEY: {},
  FOUR04_API_KEY: {},
  TAOSTATS_API_KEY: {},
  HIPPIUS_ACCESS_KEY: {},
  HIPPIUS_SECRET_KEY: {},
  HIPPIUS_BUCKET: {},
  // Changing this makes everything already stored unreadable, so the UI confirms first
  HIPPIUS_ENCRYPTION_KEY: {},
  STORAGE_MIRROR: { options: ["uploads", "off"] },
  HERITAGE_LIKENESS_POLICY: { options: ["ground-only", "private-likeness"] },
  UPLOAD_MAX_MB: {},
  ENABLE_WEB_SEARCH: { options: ["true", "false"] },
  ENABLE_LSP: { options: ["true", "false"] },
};

export const overridesFile = path.join(DATA_DIR, "settings.local.json");
configureVault(path.join(DATA_DIR, "vault.json"));
/** process.env as it came from .env / the container, before any UI overrides */
const baseEnv: Record<string, string | undefined> = { ...process.env };

let warnedIgnored = false;
/** settings.local.json only (no vault): what updateSettings rewrites. */
export function readFileOverrides(): Record<string, string> {
  try {
    if (!existsSync(overridesFile)) return {};
    const raw = JSON.parse(readFileSync(overridesFile, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    const ignored: string[] = [];
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== "string") continue;
      if (k in EDITABLE) out[k] = v;
      else ignored.push(k);
    }
    if (ignored.length && !warnedIgnored) {
      warnedIgnored = true;
      console.error(`[config] settings.local.json has keys the UI can't set; ignored: ${ignored.join(", ")} (only .env may set them; something other than the UI wrote this file)`);
    }
    return out;
  } catch (e) {
    console.error("[config] settings.local.json is unreadable; ignoring it:", e instanceof Error ? e.message : e);
    return {};
  }
}

/** Everything the UI set: the file, with secrets from the vault winning while it is unlocked. */
export function readOverrides(): Record<string, string> {
  return { ...readFileOverrides(), ...vaultValues() };
}

export function writeOverrides(values: Record<string, string>) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = overridesFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, overridesFile);
  try {
    chmodSync(overridesFile, 0o600);
  } catch {
    /* not supported on this filesystem */
  }
}

/** Where a setting's current value comes from. */
export function settingSource(key: string): "ui" | "vault" | "env" | "default" {
  if (key in vaultValues()) return "vault";
  if (key in readOverrides()) return "ui";
  return baseEnv[key] !== undefined && baseEnv[key] !== "" ? "env" : "default";
}

function applyOverrides() {
  const o = readOverrides();
  // restore anything previously overridden, then apply the current set
  for (const k of appliedKeys) if (!(k in o)) {
    if (baseEnv[k] === undefined) delete process.env[k];
    else process.env[k] = baseEnv[k];
  }
  appliedKeys.clear();
  for (const [k, v] of Object.entries(o)) {
    process.env[k] = v;
    appliedKeys.add(k);
  }
}
const appliedKeys = new Set<string>();
applyOverrides();

function buildConfig() {
  const c = {
  port: Number(env("PORT", "8787")),
  // Outside Docker, listen on loopback by default: a LAN-reachable agent API (even with a
  // token) is a foot-gun for non-experts, and with ALLOW_NO_AUTH it is wide open (see
  // assertConfig). Docker keeps 0.0.0.0 so the gateway can reach it on the internal network.
  host: env("HOST", (process.env.BITBULL_SANDBOX || (existsSync("/.dockerenv") ? "docker" : "none")) === "none" ? "127.0.0.1" : "0.0.0.0"),

  /** Bearer token protecting the API + UI. Required unless explicitly disabled. */
  appToken: env("APP_TOKEN", ""),
  allowNoAuth: bool(env("ALLOW_NO_AUTH", "false")),
  ownerName: env("OWNER_NAME", "User"),

  saygm: {
    apiKey: env("SAYGM_API_KEY", ""),
    /** OpenAI-compatible base (used for /models and OpenCode's openai-compatible provider). */
    openaiBaseUrl: env("SAYGM_OPENAI_BASE_URL", "https://api.saygm.com/v1"),
    /** Anthropic-compatible base WITHOUT /v1 (Anthropic SDKs append /v1/messages). */
    anthropicBaseUrl: env("SAYGM_ANTHROPIC_BASE_URL", "https://api.saygm.com"),
    /** "api-key" -> x-api-key header, "bearer" -> Authorization: Bearer */
    anthropicAuth: env("SAYGM_ANTHROPIC_AUTH", "api-key") as "api-key" | "bearer",
  },

  ditto: {
    mcpUrl: env("DITTO_MCP_URL", "https://api.heyditto.ai/mcp"),
    apiKey: env("DITTO_API_KEY", ""),
    /** Save every completed turn to Ditto as a memory ("turn") or not ("off"). */
    archive: env("DITTO_ARCHIVE", "turn") as "turn" | "off",
    source: env("DITTO_SOURCE", "bitbull"),
  },

  /**
   * External creative/3D services. Each is optional; when its key is set its MCP
   * server is offered to the agent (per project, see Project.integrations).
   */
  integrations: {
    atlas: {
      /** Workspace API key from Atlas → workspace settings → API Keys (atk_…) */
      apiKey: env("ATLAS_API_KEY", ""),
      /** Atlas MCP is alpha and enabled per workspace on request */
      mcpUrl: env("ATLAS_MCP_URL", "https://mcp.dev.atlas.design/mcp"),
      /** Folder of exported-workflow JSON specs (they embed credentials; keep out of git) */
      workflowsDir: "",
    },
    github: {
      /**
       * GitHub access for git push/pull/clone and the gh CLI. Accepts every token type:
       * fine-grained PAT (github_pat_…, recommended: limit it to the repos the agent needs),
       * classic PAT (ghp_…), OAuth (gho_…) and app tokens (ghu_/ghs_). GH_TOKEN works as an alias.
       */
      token: env("GITHUB_TOKEN", env("GH_TOKEN", "")),
      /** Identity for the agent's commits (defaults to OWNER_NAME / GitHub noreply) */
      userName: env("GIT_USER_NAME", env("GITHUB_USER_NAME", "")),
      userEmail: env("GIT_USER_EMAIL", env("GITHUB_USER_EMAIL", "")),
    },
    /** Taostats API key (Bittensor data). Sent raw in Authorization (no Bearer); v1 API only. */
    taostats: { apiKey: env("TAOSTATS_API_KEY", "") },
    four04: {
      /** 404.xyz (404—GEN text-to-3D). No public API documented yet: set these when 404 provides one. */
      apiKey: env("FOUR04_API_KEY", ""),
      apiBase: env("FOUR04_API_BASE", ""),
      mcpUrl: env("FOUR04_MCP_URL", ""),
    },
  },

  /**
   * Where the agent's tools run. In the Docker image BITBULL_SANDBOX=docker: the agent's
   * shell is confined to the container. On a bare host the shell is switched off
   * unless ALLOW_HOST_SHELL=true, because it would run as you on your machine.
   */
  sandbox: {
    kind: (process.env.BITBULL_SANDBOX || (existsSync("/.dockerenv") ? "docker" : "none")) as "docker" | "none" | string,
    allowHostShell: bool(env("ALLOW_HOST_SHELL", "false")),
    /** Set by docker compose: all outbound traffic goes through the allowlist proxy. */
    egressProxy: process.env.HTTPS_PROXY || process.env.https_proxy || "",
  },

  /**
   * Off-machine storage on Hippius (S3-compatible). BitBull holds the only credential: Hippius
   * sub-tokens scope to a bucket, not a folder, so prefix isolation is BitBull's job. See
   * docs/STORAGE.md.
   */
  storage: {
    endpoint: env("HIPPIUS_S3_ENDPOINT", "https://s3.hippius.com"),
    region: env("HIPPIUS_REGION", "decentralized"),
    /** Sub-token with Object Read & Write on this bucket only — never the account master key */
    accessKey: env("HIPPIUS_ACCESS_KEY", ""),
    secretKey: env("HIPPIUS_SECRET_KEY", ""),
    bucket: env("HIPPIUS_BUCKET", "bitbull-agent"),
    /** 32 bytes, base64 or hex. Without it nothing stored can ever be read back. */
    encryptionKey: env("HIPPIUS_ENCRYPTION_KEY", ""),
    /** off = store nothing; uploads = everything the user attaches or adds */
    mirror: env("STORAGE_MIRROR", "uploads") as "off" | "uploads",
    /** Skip anything larger than this (MB); a single PUT has to fit in one request */
    maxFileMb: Number(env("STORAGE_MAX_FILE_MB", "2048")),
  },

  heritage: {
    /**
     * How generated media may depict real, named people from uploads.
     *  ground-only     — real people only via Ken Burns/parallax of the original image; generative
     *                    video/3D for places, craft, weather, crowds (decision record Rev 3 default)
     *  private-likeness — generative animation of a real person's photo allowed in private,
     *                    labelled family projects, with the uploader's confirmation of rights/consent
     */
    likenessPolicy: env("HERITAGE_LIKENESS_POLICY", "ground-only") as "ground-only" | "private-likeness",
  },

  agent: {
    /** OpenCode web search via Exa (no key needed) */
    webSearch: bool(env("ENABLE_WEB_SEARCH", "true")),
    /** OpenCode LSP code-intelligence tool (experimental) */
    lsp: bool(env("ENABLE_LSP", "false")),
    defaultEngine: env("DEFAULT_ENGINE", "opencode") as EngineId,
    defaultModel: env("DEFAULT_MODEL", "claude-sonnet-4-5"),
    /** Cheap model for titles / background work. */
    smallModel: env("SMALL_MODEL", env("DEFAULT_MODEL", "claude-sonnet-4-5")),
    permissionMode: env("AGENT_PERMISSION_MODE", "bypassPermissions"),
    /** Route Claude models in OpenCode through SayGM's Anthropic endpoint (native caching/thinking). */
    opencodeClaudeNative: bool(env("OPENCODE_CLAUDE_NATIVE", "true")),
    opencodePort: Number(env("OPENCODE_PORT", "4096")),
    /**
     * Default model for subagents (reviewer, challenger, debugger…). "inherit" = same model as
     * the chat. Per agent: SUBAGENT_MODEL_<NAME>, e.g. SUBAGENT_MODEL_REVIEWER=gpt-5.5.
     */
    subagentModel: env("SUBAGENT_MODEL", "inherit"),
    /**
     * How long a finished turn's event log is kept so a client can replay it (days; 0 = forever).
     * This is a re-attach buffer, not history: messages and tool calls live in `messages`.
     */
    turnRetentionDays: Number(env("TURN_RETENTION_DAYS", "7")),
  },

  dataDir: path.resolve(env("DATA_DIR", path.join(ROOT, "data"))),
  skillsDir: path.resolve(env("SKILLS_DIR", path.join(ROOT, "skills"))),
  subagentsDir: path.resolve(env("SUBAGENTS_DIR", path.join(ROOT, "subagents"))),
  /** Max size of one uploaded file (MB) */
  uploadMaxMb: Number(env("UPLOAD_MAX_MB", "100")),
  promptFile: path.resolve(env("SYSTEM_PROMPT_FILE", path.join(ROOT, "agent", "SYSTEM.md"))),
  webDist: path.resolve(env("WEB_DIST", path.join(ROOT, "web", "dist"))),
  };
  c.integrations.atlas.workflowsDir = path.resolve(env("ATLAS_WORKFLOWS_DIR", path.join(c.dataDir, "integrations", "atlas", "workflows")));
  return c;
}

export const config = buildConfig();

/** Bumped whenever settings change at runtime; long-lived clients (OpenCode, Ditto) reconnect on it. */
export let configVersion = 1;

/** Re-read .env + UI overrides and update the live config in place. */
export function reloadConfig() {
  applyOverrides();
  Object.assign(config, buildConfig());
  applyGitEnv();
  configVersion++;
}

export const paths = {
  db: path.join(config.dataDir, "agent.db"),
  workspace: path.join(config.dataDir, "workspace"),
  /** One workspace per project, kept apart from the general workspace */
  projects: path.join(config.dataDir, "projects"),
  integrations: path.join(config.dataDir, "integrations"),
  claudeConfig: path.resolve(env("CLAUDE_DATA_DIR", path.join(config.dataDir, "claude"))),
  opencodeData: path.resolve(env("OPENCODE_DATA_DIR", path.join(config.dataDir, "opencode"))),
};


for (const p of [config.dataDir, paths.workspace, paths.projects, paths.claudeConfig, paths.opencodeData, config.integrations.atlas.workflowsDir]) {
  mkdirSync(p, { recursive: true });
}

// In the sandbox HOME/XDG dirs point into /data (the root filesystem is read-only)
for (const k of ["HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
  const d = process.env[k];
  if (d && config.sandbox.kind !== "none") {
    try {
      mkdirSync(d, { recursive: true });
    } catch {
      /* not fatal */
    }
  }
}

/** What kind of GitHub token is configured (shown in Settings; never the token itself). */
export function githubTokenKind(t = config.integrations.github.token) {
  if (!t) return "none";
  if (t.startsWith("github_pat_")) return "fine-grained PAT";
  if (t.startsWith("ghp_")) return "classic PAT";
  if (t.startsWith("gho_")) return "OAuth token";
  if (t.startsWith("ghu_") || t.startsWith("ghs_")) return "GitHub App token";
  return "token (unrecognised prefix)";
}

/**
 * Hand the GitHub token to git and gh for every process the agent starts (they inherit
 * this environment). git gets it through a credential helper for github.com only, so it
 * never appears in remotes, command lines or .git/config.
 */
function applyGitEnv() {
  const g = config.integrations.github;
  const set: Array<[string, string]> = [];
  for (const k of Object.keys(process.env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete process.env[k];
  if (!g.token) {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  }
  if (g.token) {
    process.env.GH_TOKEN = g.token;
    process.env.GITHUB_TOKEN = g.token;
    set.push([
      "credential.https://github.com.helper",
      '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GITHUB_TOKEN"; }; f',
    ]);
  }
  const name = g.userName || config.ownerName;
  const email = g.userEmail;
  if (name) set.push(["user.name", name]);
  if (email) set.push(["user.email", email]);
  set.push(["init.defaultBranch", "main"], ["safe.directory", "*"]);
  process.env.GIT_CONFIG_COUNT = String(set.length);
  set.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
}
applyGitEnv();

export function assertConfig() {
  const problems: string[] = [];
  if (!config.saygm.apiKey) problems.push("SAYGM_API_KEY is not set");
  if (!config.appToken && !config.allowNoAuth)
    problems.push("APP_TOKEN is not set (or set ALLOW_NO_AUTH=true for local-only use)");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host); // "::" and 0.0.0.0 are any-address, never loopback
  if (config.allowNoAuth && !config.appToken && !loopback)
    problems.push(
      `ALLOW_NO_AUTH=true with HOST=${config.host} exposes the entire unauthenticated API (agent, files, settings) to your network. Bind 127.0.0.1 or set APP_TOKEN.`,
    );
  if (!config.appToken) console.warn("[config] WARNING: no APP_TOKEN — every route is unauthenticated. Local-only use only.");
  if (problems.length) throw new Error("Config errors:\n - " + problems.join("\n - "));
}

/** May the agent run shell commands? Always inside a sandbox; on the host only if explicitly allowed. */
export const shellAllowed = () =>
  config.agent.permissionMode === "bypassPermissions" && (config.sandbox.kind !== "none" || config.sandbox.allowHostShell);
