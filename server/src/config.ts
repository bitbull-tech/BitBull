import { existsSync, mkdirSync } from "node:fs";
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
    four04: {
      /** 404.xyz (404—GEN text-to-3D). No public API documented yet: set these when 404 provides one. */
      apiKey: env("FOUR04_API_KEY", ""),
      apiBase: env("FOUR04_API_BASE", ""),
      mcpUrl: env("FOUR04_MCP_URL", ""),
    },
  },

  /**
   * Where the agent's tools run. In the Docker image GM_SANDBOX=docker: the agent's
   * shell is confined to the container. On a bare host the shell is switched off
   * unless ALLOW_HOST_SHELL=true, because it would run as you on your machine.
   */
  sandbox: {
    kind: (process.env.GM_SANDBOX || (existsSync("/.dockerenv") ? "docker" : "none")) as "docker" | "none" | string,
    allowHostShell: bool(env("ALLOW_HOST_SHELL", "false")),
    /** Set by docker compose: all outbound traffic goes through the allowlist proxy. */
    egressProxy: process.env.HTTPS_PROXY || process.env.https_proxy || "",
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
  },

  dataDir: path.resolve(env("DATA_DIR", path.join(ROOT, "data"))),
  skillsDir: path.resolve(env("SKILLS_DIR", path.join(ROOT, "skills"))),
  promptFile: path.resolve(env("SYSTEM_PROMPT_FILE", path.join(ROOT, "agent", "SYSTEM.md"))),
  webDist: path.resolve(env("WEB_DIST", path.join(ROOT, "web", "dist"))),
};

export const paths = {
  db: path.join(config.dataDir, "agent.db"),
  workspace: path.join(config.dataDir, "workspace"),
  /** One workspace per project, kept apart from the general workspace */
  projects: path.join(config.dataDir, "projects"),
  integrations: path.join(config.dataDir, "integrations"),
  claudeConfig: path.resolve(env("CLAUDE_DATA_DIR", path.join(config.dataDir, "claude"))),
  opencodeData: path.resolve(env("OPENCODE_DATA_DIR", path.join(config.dataDir, "opencode"))),
};

config.integrations.atlas.workflowsDir = path.resolve(
  env("ATLAS_WORKFLOWS_DIR", path.join(config.dataDir, "integrations", "atlas", "workflows")),
);

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

export function assertConfig() {
  const problems: string[] = [];
  if (!config.saygm.apiKey) problems.push("SAYGM_API_KEY is not set");
  if (!config.appToken && !config.allowNoAuth)
    problems.push("APP_TOKEN is not set (or set ALLOW_NO_AUTH=true for local-only use)");
  if (!config.ditto.apiKey) console.warn("[config] DITTO_API_KEY not set — memory disabled");
  if (problems.length) throw new Error("Config errors:\n - " + problems.join("\n - "));
}

/** May the agent run shell commands? Always inside a sandbox; on the host only if explicitly allowed. */
export const shellAllowed = () =>
  config.agent.permissionMode === "bypassPermissions" && (config.sandbox.kind !== "none" || config.sandbox.allowHostShell);
