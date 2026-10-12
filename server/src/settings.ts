import { existsSync } from "node:fs";
import { config, githubTokenKind, paths, shellAllowed } from "./config.js";
import { probeDitto } from "./ditto.js";
import { listModels } from "./models.js";
import { listSkills } from "./skills.js";
import { listSubagents } from "./subagents.js";

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
        row("GM_SANDBOX", "Sandbox", config.sandbox.kind === "none" ? "none (running on host)" : config.sandbox.kind, { hint: "Set automatically inside the Docker image" }),
        row("HTTPS_PROXY", "Outbound traffic", config.sandbox.egressProxy ? `allowlist proxy (${config.sandbox.egressProxy})` : "open (no proxy)", { hint: "docker compose routes the agent through egress/allowlist.txt" }),
        row("ALLOW_HOST_SHELL", "Allow shell on host", config.sandbox.allowHostShell, { hint: "Only matters outside the sandbox. Leave false." }),
        row("AGENT_PERMISSION_MODE", "Permission mode", config.agent.permissionMode, { hint: "bypassPermissions lets the agent edit files and run shell in its workspace" }),
        row("OPENCODE_CLAUDE_NATIVE", "Claude via native Anthropic API", config.agent.opencodeClaudeNative),
        row("SUBAGENT_MODEL", "Subagent model", config.agent.subagentModel, { hint: "inherit = same as the chat. Per agent: SUBAGENT_MODEL_REVIEWER=gpt-5.5 etc." }),
        row("UPLOAD_MAX_MB", "Max upload size per file (MB)", config.uploadMaxMb),
        row("ENABLE_WEB_SEARCH", "Web search tool (OpenCode)", config.agent.webSearch, { hint: "Exa-backed websearch; no key needed" }),
        row("ENABLE_LSP", "LSP code intelligence (OpenCode)", config.agent.lsp, { hint: "Experimental: definitions, references, hover" }),
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
    {
      id: "github",
      title: "GitHub",
      rows: [
        row("GITHUB_TOKEN", `Token (${githubTokenKind()})`, config.integrations.github.token, {
          secret: true,
          hint: "Fine-grained (github_pat_…) recommended, limited to the repos the agent needs; classic (ghp_…) also works. GH_TOKEN is accepted too.",
        }),
        row("GIT_USER_NAME", "Commit author name", config.integrations.github.userName || config.ownerName),
        row("GIT_USER_EMAIL", "Commit author email", config.integrations.github.userEmail),
      ],
    },
    {
      id: "atlas",
      title: "Atlas AI Studio",
      rows: [
        row("ATLAS_API_KEY", "Workspace API key (atk_…)", config.integrations.atlas.apiKey, { secret: true, hint: "Atlas → workspace settings → API Keys. MCP must be enabled for the workspace by Atlas." }),
        row("ATLAS_MCP_URL", "MCP endpoint", config.integrations.atlas.mcpUrl),
        row("ATLAS_WORKFLOWS_DIR", "Exported workflow specs", config.integrations.atlas.workflowsDir, { hint: "Drop exported workflow JSON files here; they hold credentials, so keep them out of git" }),
      ],
    },
    {
      id: "four04",
      title: "404.xyz (404—GEN)",
      rows: [
        row("FOUR04_API_KEY", "API key", config.integrations.four04.apiKey, { secret: true }),
        row("FOUR04_API_BASE", "API base URL", config.integrations.four04.apiBase, { hint: "No public API documented yet; fill in when 404 provides one" }),
        row("FOUR04_MCP_URL", "MCP endpoint", config.integrations.four04.mcpUrl),
      ],
    },
    {
      id: "heritage",
      title: "Heritage experiences",
      rows: [
        row("HERITAGE_LIKENESS_POLICY", "Likeness policy", config.heritage.likenessPolicy, {
          hint: "ground-only: real people only via their original images, generate the world around them. private-likeness: allow animating family photos in private, labelled projects",
        }),
      ],
    },
  ];
}

/** Reject after ms so a stuck network call can't hang the Status panel. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s (network or egress proxy?)`)), ms)),
  ]);
}

/** Cheap live checks (no model tokens spent). */
export async function status() {
  const t0 = Date.now();
  let saygm: { ok: boolean; models?: number; ms?: number; error?: string };
  try {
    const models = await withTimeout(listModels(true), 15000, "SayGM model list");
    saygm = { ok: models.length > 1, models: models.length, ms: Date.now() - t0 };
  } catch (e) {
    saygm = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const d = await withTimeout(probeDitto(), 15000, "Ditto").catch(
    (e: Error) => ({ enabled: true, ok: false, error: e.message }) as Awaited<ReturnType<typeof probeDitto>>,
  );
  return {
    saygm,
    ditto: d.enabled ? { ok: !!d.ok, tools: "tools" in d ? d.tools?.length : 0, error: "error" in d ? d.error : undefined } : { ok: false, error: "DITTO_API_KEY not set" },
    skills: listSkills().map((s) => ({ name: s.name, description: s.description })),
    subagents: listSubagents().map((a) => ({ name: a.name, description: a.description, access: a.access, model: a.model })),
    workspace: paths.workspace,
    sandbox: { kind: config.sandbox.kind, shell: shellAllowed(), egress: config.sandbox.egressProxy ? "allowlist" : "open" },
    systemPromptFound: existsSync(config.promptFile),
    node: process.version,
  };
}
