import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export const config = {
  port: Number(env("PORT", "8787")),
  host: env("HOST", "0.0.0.0"),

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
    source: env("DITTO_SOURCE", "saygm-agent"),
  },

  agent: {
    defaultEngine: env("DEFAULT_ENGINE", "opencode") as EngineId,
    defaultModel: env("DEFAULT_MODEL", "claude-sonnet-4-5"),
    /** Cheap model for titles / background work. */
    smallModel: env("SMALL_MODEL", env("DEFAULT_MODEL", "claude-sonnet-4-5")),
    permissionMode: env("AGENT_PERMISSION_MODE", "bypassPermissions"),
    /** Route Claude models in OpenCode through SayGM's Anthropic endpoint (native caching/thinking). */
    opencodeClaudeNative: bool(env("OPENCODE_CLAUDE_NATIVE", "true")),
    opencodePort: Number(env("OPENCODE_PORT", "4096")),
  },

  dataDir: path.resolve(env("DATA_DIR", path.join(ROOT, "data"))),
  skillsDir: path.resolve(env("SKILLS_DIR", path.join(ROOT, "skills"))),
  promptFile: path.resolve(env("SYSTEM_PROMPT_FILE", path.join(ROOT, "agent", "SYSTEM.md"))),
  webDist: path.resolve(env("WEB_DIST", path.join(ROOT, "web", "dist"))),
};

export const paths = {
  db: path.join(config.dataDir, "agent.db"),
  workspace: path.join(config.dataDir, "workspace"),
  claudeConfig: path.join(config.dataDir, "claude"),
  opencodeData: path.join(config.dataDir, "opencode"),
};

for (const p of [config.dataDir, paths.workspace, paths.claudeConfig, paths.opencodeData]) {
  mkdirSync(p, { recursive: true });
}

export function assertConfig() {
  const problems: string[] = [];
  if (!config.saygm.apiKey) problems.push("SAYGM_API_KEY is not set");
  if (!config.appToken && !config.allowNoAuth)
    problems.push("APP_TOKEN is not set (or set ALLOW_NO_AUTH=true for local-only use)");
  if (!config.ditto.apiKey) console.warn("[config] DITTO_API_KEY not set — memory disabled");
  if (problems.length) throw new Error("Config errors:\n - " + problems.join("\n - "));
}
