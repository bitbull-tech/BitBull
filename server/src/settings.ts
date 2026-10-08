import { existsSync } from "node:fs";
import { config, paths } from "./config.js";
import { probeDitto } from "./ditto.js";
import { listModels } from "./models.js";
import { listSkills } from "./skills.js";

/**
 * Read-only view of the configuration the server is actually running with,
 * for the Settings panel. Secrets are masked; values come from .env (or defaults).
 */
export interface SettingRow {
  env: string;
  label: string;
  value: string;
  secret?: boolean;
  /** true when the env var isn't set and the built-in default is in use */
  isDefault: boolean;
  hint?: string;
}

const mask = (v: string) => (!v ? "(not set)" : v.length <= 12 ? "•".repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)}`);
const isSet = (k: string) => !!process.env[k];

function row(env: string, label: string, value: unknown, opts: { secret?: boolean; hint?: string } = {}): SettingRow {
  const v = value === undefined || value === null ? "" : String(value);
  return { env, label, value: opts.secret ? mask(v) : v || "(not set)", secret: opts.secret, isDefault: !isSet(env), hint: opts.hint };
}

export function describeSettings() {
  return [
    {
      id: "gm",
      title: "GM Agent",
      rows: [
        row("DEFAULT_ENGINE", "Default engine", config.agent.defaultEngine, { hint: "opencode = any model natively; claude = Claude Agent SDK" }),
        row("DEFAULT_MODEL", "Default model", config.agent.defaultModel),
        row("SMALL_MODEL", "Small / background model", config.agent.smallModel, { hint: "Used for titles and cheap background work" }),
        row("AGENT_PERMISSION_MODE", "Permission mode", config.agent.permissionMode, { hint: "bypassPermissions lets the agent edit files and run shell in its workspace" }),
        row("OPENCODE_CLAUDE_NATIVE", "Claude via native Anthropic API", config.agent.opencodeClaudeNative),
        row("OWNER_NAME", "Owner name", config.ownerName),
        row("APP_TOKEN", "Access token", config.appToken, { secret: true }),
        row("SYSTEM_PROMPT_FILE", "System prompt", config.promptFile),
        row("SKILLS_DIR", "Skills folder", config.skillsDir),
        row("DATA_DIR", "Data folder", config.dataDir, { hint: "Chats DB, agent workspace, logs" }),
        row("PORT", "Port", config.port),
      ],
    },
    {
      id: "saygm",
      title: "SayGM",
      rows: [
        row("SAYGM_API_KEY", "API key", config.saygm.apiKey, { secret: true }),
        row("SAYGM_OPENAI_BASE_URL", "OpenAI-compatible base URL", config.saygm.openaiBaseUrl),
        row("SAYGM_ANTHROPIC_BASE_URL", "Anthropic / Google base URL", config.saygm.anthropicBaseUrl),
        row("SAYGM_ANTHROPIC_AUTH", "Anthropic auth header", config.saygm.anthropicAuth),
      ],
    },
    {
      id: "ditto",
      title: "Ditto memory",
      rows: [
        row("DITTO_API_KEY", "API key", config.ditto.apiKey, { secret: true }),
        row("DITTO_MCP_URL", "MCP server", config.ditto.mcpUrl),
        row("DITTO_ARCHIVE", "Archive every turn", config.ditto.archive, { hint: "turn = save each exchange; off = only facts the agent saves" }),
        row("DITTO_SOURCE", "Source label", config.ditto.source),
      ],
    },
  ];
}

/** Cheap live checks (no model tokens spent). */
export async function status() {
  const t0 = Date.now();
  let saygm: { ok: boolean; models?: number; ms?: number; error?: string };
  try {
    const models = await listModels(true);
    saygm = { ok: models.length > 1, models: models.length, ms: Date.now() - t0 };
  } catch (e) {
    saygm = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const d = await probeDitto();
  return {
    saygm,
    ditto: d.enabled ? { ok: !!d.ok, tools: "tools" in d ? d.tools?.length : 0, error: "error" in d ? d.error : undefined } : { ok: false, error: "DITTO_API_KEY not set" },
    skills: listSkills().map((s) => ({ name: s.name, description: s.description })),
    workspace: paths.workspace,
    systemPromptFound: existsSync(config.promptFile),
    node: process.version,
  };
}
