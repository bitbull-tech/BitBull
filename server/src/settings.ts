import { existsSync } from "node:fs";
import { config, githubTokenKind, paths, readFileOverrides, reloadConfig, settingSource, shellAllowed, writeOverrides, EDITABLE } from "./config.js";
import { record } from "./activity.js";
import { resetDitto } from "./ditto.js";
import { probeDitto } from "./ditto.js";
import { probeStorage, resetStorage } from "./storage.js";
import { VAULT_KEYS, vaultSet, vaultUnlocked } from "./vault.js";
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
  /** can be changed from the UI (saved to settings.local.json) */
  editable?: boolean;
  /** where the value comes from */
  source: "ui" | "vault" | "env" | "default";
  /** for editable choices */
  options?: string[];
}

/**
 * Settings that can be changed from the UI. Deliberately excludes anything that controls
 * access or the sandbox (APP_TOKEN, ALLOW_*, BITBULL_SANDBOX, permissions, ports, paths, proxy),
 * so a compromised browser session can't switch off the walls.
 */
export { EDITABLE };

/**
 * Save values from the UI and apply them live. null or "" removes the UI value so .env
 * (or the default) applies again. Returns the keys changed.
 */
export async function updateSettings(values: Record<string, string | null>) {
  const bad = Object.keys(values).filter((k) => !(k in EDITABLE));
  if (bad.length) throw new Error(`Not editable from the UI: ${bad.join(", ")}`);
  for (const [k, v] of Object.entries(values)) {
    const opts = EDITABLE[k].options;
    if (v && opts && !opts.includes(v)) throw new Error(`${k} must be one of: ${opts.join(", ")}`);
    if (v && /[\r\n]/.test(v)) throw new Error(`${k} can't contain line breaks`);
    if (k === "UPLOAD_MAX_MB" && v && !(Number(v) > 0)) throw new Error("UPLOAD_MAX_MB must be a positive number");
    // Reject a bad encryption key here rather than at the first upload, when it is too late
    if (k === "HIPPIUS_ENCRYPTION_KEY" && v) {
      const buf = /^[0-9a-f]{64}$/i.test(v.trim()) ? Buffer.from(v.trim(), "hex") : Buffer.from(v.trim(), "base64");
      if (buf.length !== 32) throw new Error("HIPPIUS_ENCRYPTION_KEY must be 32 bytes (44 base64 characters, or 64 hex)");
    }
  }
  // secrets go to the vault when it is unlocked (and leave settings.local.json if they were there);
  // other settings, and secrets while the vault is locked, go to settings.local.json as before
  const cur = readFileOverrides();
  let toFile = false;
  for (const [k, v] of Object.entries(values)) {
    if (VAULT_KEYS.has(k) && vaultUnlocked()) {
      vaultSet(k, v);
      if (k in cur) delete cur[k];
      toFile = true;
      continue;
    }
    if (v === null || v.trim() === "") delete cur[k];
    else cur[k] = v.trim();
    toFile = true;
  }
  if (toFile) writeOverrides(cur);
  reloadConfig();
  resetDitto();
  resetStorage();
  await listModels(true).catch(() => []);
  const changed = Object.keys(values);
  record({ level: "info", source: "config", message: `Settings changed in the UI: ${changed.join(", ")} (values not logged)` });
  return changed;
}

const mask = (v: string) => (!v ? "(not set)" : v.length <= 12 ? "•".repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)}`);
const isSet = (k: string) => !!process.env[k];

function row(env: string, label: string, value: unknown, opts: { secret?: boolean; hint?: string } = {}): SettingRow {
  const v = value === undefined || value === null ? "" : String(value);
  const source = settingSource(env);
  return {
    env,
    label,
    value: opts.secret ? mask(v) : v || "(not set)",
    secret: opts.secret,
    isDefault: source === "default" && !isSet(env),
    hint: opts.hint,
    source,
    ...(env in EDITABLE ? { editable: true, ...(EDITABLE[env].options ? { options: EDITABLE[env].options } : {}) } : {}),
  };
}

export function describeSettings() {
  return [
    {
      id: "bitbull",
      title: "BitBull",
      rows: [
        row("DEFAULT_ENGINE", "Default engine", config.agent.defaultEngine, { hint: "opencode = any model natively; claude = Claude Agent SDK" }),
        row("DEFAULT_MODEL", "Default model", config.agent.defaultModel),
        row("SMALL_MODEL", "Small / background model", config.agent.smallModel, { hint: "Used for titles and cheap background work (on SayGM)" }),
        row("BACKGROUND_VIA", "Background work runs on", config.router.background, {
          hint: "saygm = the small model above. ditto-router = the Ditto Router model chosen below (needs a Router key under Integrations → Ditto). Only the OpenCode engine's background calls move; chats stay on SayGM.",
        }),
        row("DITTO_ROUTER_MODEL", "Ditto Router background model", config.router.model, { hint: "Pick from the Router's model list below." }),
        row("ADVISOR_MODEL", "Advisor model", config.agent.advisorModel, { hint: "Answers \"Which model for this?\" on the home screen, from the live catalogue and your usage. A cheap model is enough; defaults to the small model." }),
        row("VOICE_STT_MODEL", "Voice: listening model", config.voice.sttModel || "(cheapest Gemini flash)", { hint: "A Gemini model on SayGM turns what you say into text. Empty: the cheapest flash model in the catalogue." }),
        row("ADVISOR_STRONG_MODEL", "Stronger advisor", config.agent.advisorStrongModel, { hint: "Used by \"Ask a stronger model\". Defaults to the default model." }),
        row("BITBULL_SANDBOX", "Sandbox", config.sandbox.kind === "none" ? "none (running on host)" : config.sandbox.kind, { hint: "Set automatically inside the Docker image" }),
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
        row("DITTO_ROUTER_KEY", "Router key (ditto_inf_…)", config.router.key, {
          secret: true,
          hint: "A key from developer.heyditto.ai → Endpoints → your endpoint → API keys. Used only for background work when Configuration → Background work runs on = ditto-router.",
        }),
        row("DITTO_ROUTER_BASE_URL", "Router base URL", config.router.baseUrl),
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
      id: "taostats",
      title: "Taostats",
      rows: [
        row("TAOSTATS_API_KEY", "API key", config.integrations.taostats.apiKey, {
          secret: true,
          hint: "Bittensor data via https://api.taostats.io/v1 (old /api/ routes stop on 9 Nov 2026). The agent reads it from its environment; see the taostats-api skill.",
        }),
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
      id: "hippius",
      title: "Hippius storage",
      rows: [
        row("HIPPIUS_ACCESS_KEY", "Sub-token access key", config.storage.accessKey, {
          secret: true,
          hint: "Hippius console → S3 Buckets → Sub Tokens. Object Read & Write, limited to this bucket. Never the account master key.",
        }),
        row("HIPPIUS_SECRET_KEY", "Sub-token secret", config.storage.secretKey, { secret: true, hint: "Shown once when the sub-token is created" }),
        row("HIPPIUS_BUCKET", "Bucket", config.storage.bucket, { hint: "Create it in the Hippius console first" }),
        row("HIPPIUS_ENCRYPTION_KEY", "Encryption key", config.storage.encryptionKey, {
          secret: true,
          hint: "32 bytes, base64. Files are encrypted with this before they leave the machine. Keep a copy somewhere else: without it, nothing stored can be read back, and changing it orphans everything already stored.",
        }),
        row("STORAGE_MIRROR", "What to store", config.storage.mirror, { hint: "uploads: everything you attach or add through Files. off: store nothing." }),
        row("HIPPIUS_S3_ENDPOINT", "Endpoint", config.storage.endpoint),
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
    storage: await withTimeout(probeStorage(), 15000, "Hippius").catch((e: Error) => ({ ok: false, configured: true, detail: e.message })),
    workspace: paths.workspace,
    sandbox: { kind: config.sandbox.kind, shell: shellAllowed(), egress: config.sandbox.egressProxy ? "allowlist" : "open" },
    systemPromptFound: existsSync(config.promptFile),
    node: process.version,
  };
}
