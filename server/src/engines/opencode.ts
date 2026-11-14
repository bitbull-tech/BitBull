import { pathToFileURL } from "node:url";
import { checkSubagentModels, listSubagents, opencodeAgentAccess, subagentsSignature } from "../subagents.js";
import { createServer } from "node:net";
import path from "node:path";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { config, configVersion, paths, ROOT, shellAllowed } from "../config.js";
import { dittoMcpHeaders } from "../ditto.js";
import { bitbullMcpServer } from "../mcp.js";
import { LINKS_ROOT, linksAvailable } from "../links.js";
import { allIntegrationMcps, integrations } from "../integrations.js";
import { chatModels, fromRouter, routerRefusal, type ModelApi, type ModelInfo } from "../models.js";
import type { AgentEngine, AgentEvent, RunInput, Usage } from "./types.js";
import {
  cachedRouterReview,
  ROUTER_HEADERS,
  routerBaseUrl,
  routerBackground,
  routerMcpServers,
  routerModelId,
  routerReview,
  reviewModelId,
  type RouterMcpServer,
} from "../router.js";

/**
 * Engine 2: OpenCode (open source, provider-agnostic agent runtime).
 * Talks to every model natively: Claude models via their gateway's Anthropic
 * endpoint (@ai-sdk/anthropic), everything else via its OpenAI-compatible
 * endpoint (@ai-sdk/openai-compatible). Tools, MCP (Ditto) and skills behave the
 * same regardless of model or gateway (SayGM, or Ditto Router: server/src/router.ts).
 */

type Provider = { id: string; npm: string; name: string; baseURL: () => string; apiKey: () => string; headers?: Record<string, string> };
const saygmKey = () => config.saygm.apiKey;

/** One OpenCode provider per gateway and API shape, so every model speaks its native protocol. */
const PROVIDERS: Record<ModelApi, Provider> = {
  anthropic: { id: "saygm-anthropic", npm: "@ai-sdk/anthropic", name: "SayGM · Anthropic", baseURL: () => `${config.saygm.anthropicBaseUrl}/v1`, apiKey: saygmKey },
  responses: { id: "saygm-openai", npm: "@ai-sdk/openai", name: "SayGM · OpenAI", baseURL: () => config.saygm.openaiBaseUrl, apiKey: saygmKey },
  google: { id: "saygm-google", npm: "@ai-sdk/google", name: "SayGM · Google", baseURL: () => `${config.saygm.anthropicBaseUrl}/v1beta`, apiKey: saygmKey },
  chat: { id: "saygm", npm: "@ai-sdk/openai-compatible", name: "SayGM", baseURL: () => config.saygm.openaiBaseUrl, apiKey: saygmKey },
};
/**
 * Ditto Router serves both shapes on one /v1; its own ids are what OpenCode sends. Plan mode
 * (and so QA Hound) uses the review endpoint's key: no memory recall or recording there, so what a
 * reviewer reads in a possibly hostile repo never reaches long-term memory.
 */
function routerProvider(api: ModelApi, review: boolean): Provider {
  const anthropic = api === "anthropic";
  return {
    id: `ditto-router${review ? "-review" : ""}${anthropic ? "-anthropic" : ""}`,
    npm: anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
    name: `Ditto Router${review ? " (review)" : ""}${anthropic ? " · Anthropic" : ""}`,
    baseURL: routerBaseUrl,
    apiKey: () => (review ? config.router.reviewKey : config.router.key),
    headers: ROUTER_HEADERS,
  };
}

// Make the bundled `opencode` binary resolvable and keep its state in DATA_DIR.
process.env.PATH = `${path.join(ROOT, "server", "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.XDG_DATA_HOME = paths.opencodeData;
process.env.XDG_STATE_HOME = paths.opencodeData;
// Optional built-in tools (read by the opencode process at startup)
if (config.agent.webSearch) process.env.OPENCODE_ENABLE_EXA = "1";
if (config.agent.lsp) process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = "true";

/** Read-only planning agent (OpenCode's built-in "plan" agent asks for approvals, which this UI can't answer). */
const PLAN_AGENT = "bitbull-plan";
const PLAN_PROMPT = [
  "You are in PLAN MODE. Investigate with read-only tools (read, grep, glob, webfetch) and produce a plan. Memory and other connected services are switched off in this mode.",
  "Do not edit files, write files or run commands that change anything.",
  "Finish with: the goal as you understand it, findings, a numbered step-by-step plan with the files involved, risks, and open questions for the user.",
].join(" ");

type AnyEvent = { type: string; properties?: any };
type Listener = (ev: AnyEvent) => void;

type Running = { client: OpencodeClient; close(): void; models: Set<string>; agents: string; cfg: number; mcp: RouterMcpServer[]; router: string };

/** What OpenCode's config takes from Ditto Router (the endpoint's MCP catalog, the review endpoint); a change restarts it. */
const routerSignature = (servers: RouterMcpServer[]) => JSON.stringify([servers.map((s) => [s.name, s.url, s.deny]), cachedRouterReview()]);

/** Plan mode runs on the review endpoint when it is there and checked to have no memory and no tools. */
const reviewReady = () => !!config.router.reviewKey && !!cachedRouterReview()?.safe;
let server: Running | null = null;
let starting: Promise<Running> | null = null;
const listeners = new Map<string, Set<Listener>>();
let activeRuns = 0;

function providerFor(m: Pick<ModelInfo, "api" | "gateway">, review = false): Provider {
  let api: ModelApi = m.api ?? "chat";
  if (api === "anthropic" && !config.agent.opencodeClaudeNative) api = "chat";
  if (m.gateway === "ditto-router") return routerProvider(api === "anthropic" ? api : "chat", review);
  return PROVIDERS[api];
}

/** OpenCode's "<provider>/<model>" for a model: the gateway's own model id behind its provider. */
const ref = (m: ModelInfo, review = false) => {
  const routerId = routerModelId(m.id);
  // on the review endpoint, the chat endpoint's own entry becomes the review endpoint's
  const modelID = routerId === null ? m.id : review ? reviewModelId({ id: routerId, endpoint: m.endpoint }) : routerId;
  return { providerID: providerFor(m, review).id, modelID };
};
const refString = (m: ModelInfo, review = false) => `${ref(m, review).providerID}/${ref(m, review).modelID}`;

export function buildConfig(models: ModelInfo[], routerMcp: RouterMcpServer[] = []) {
  type Entry = {
    name: string;
    limit?: { context: number; output: number };
    cost?: { input: number; output: number; cache_read?: number };
  };
  // Background work on Ditto Router (Configuration → Background work runs on) moves the small
  // model there; declared even when the Router's list could not be fetched just now
  const bg = routerBackground();
  const bgModel = bg ? (models.find((m) => routerModelId(m.id) === bg.model) ?? fromRouter({ id: bg.model, name: bg.model })) : undefined;
  if (bgModel && !models.includes(bgModel)) models = [...models, bgModel];
  const providers = new Map<string, Provider>();
  const byProvider: Record<string, Record<string, Entry>> = {};
  const declare = (p: Provider, modelID: string, entry: Entry) => {
    providers.set(p.id, p);
    (byProvider[p.id] ??= {})[modelID] = entry;
  };
  for (const m of models) {
    const entry: Entry = {
      name: m.name,
      ...(m.contextLength ? { limit: { context: m.contextLength, output: Math.min(32000, m.contextLength) } } : {}),
      // Live gateway prices ($/Mtok) so OpenCode's own cost tracking is right
      ...(m.price ? { cost: { input: m.price.input, output: m.price.output, ...(m.price.cacheRead ? { cache_read: m.price.cacheRead } : {}) } } : {}),
    };
    declare(providerFor(m), ref(m).modelID, entry);
    if (m.gateway === "ditto-router" && reviewReady()) declare(providerFor(m, true), ref(m, true).modelID, entry);
  }
  const allow = config.agent.permissionMode === "bypassPermissions";
  const def = models.find((m) => m.id === config.agent.defaultModel) ?? models.find((m) => m.api === "anthropic") ?? models[0];
  const small = bgModel ?? models.find((m) => m.id === config.agent.smallModel) ?? models.find((m) => /haiku|mini|flash/i.test(m.id)) ?? def;
  const provider: Record<string, unknown> = {};
  for (const p of providers.values()) {
    provider[p.id] = { npm: p.npm, name: p.name, options: { baseURL: p.baseURL(), apiKey: p.apiKey(), ...(p.headers ? { headers: p.headers } : {}) }, models: byProvider[p.id] };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    // The guard keeps BitBull's credentials out of the agent's shell and out of tool output;
    // ditto-router gives each chat its own Router thread (agent/opencode-plugin)
    plugin: ["bitbull-guard.js", ...(config.router.key ? ["ditto-router.js"] : [])].map((f) => pathToFileURL(path.join(ROOT, "agent", "opencode-plugin", f)).href),
    share: "disabled" as const,
    model: def ? refString(def) : undefined,
    // Housekeeping (titles, summaries) needs no memory: on the review endpoint when it's ready, so a
    // plan-mode chat's background calls don't reach the chat endpoint's memory either
    small_model: small ? refString(small, small.gateway === "ditto-router" && reviewReady()) : undefined,
    enabled_providers: Object.keys(provider),
    provider,
    mcp: {
      // Memory: the Router endpoint's built-in "ditto" server when there is one, else Ditto's MCP
      // with the account key
      ...(config.ditto.apiKey && !routerMcp.some((s) => s.name === "ditto")
        ? { ditto: { type: "remote" as const, url: config.ditto.mcpUrl, headers: dittoMcpHeaders(), oauth: false as const, timeout: 15000 } }
        : {}),
      // The Router endpoint's tools (server/src/router.ts)
      ...Object.fromEntries(routerMcp.map((s) => [s.name, { type: "remote" as const, url: s.url, headers: s.headers, oauth: false as const, timeout: 15000 }])),
      // BitBull's own tools (network access requests); waits for the user, hence the long timeout
      ...(bitbullMcpServer()
        ? { bitbull: { type: "remote" as const, url: bitbullMcpServer()!.url, headers: bitbullMcpServer()!.headers, oauth: false as const, timeout: 660000 } }
        : {}),
      // Integration MCPs are registered once here and switched on/off per prompt by project
      ...Object.fromEntries(
        Object.entries(allIntegrationMcps()).map(([k, v]) => [k, { type: "remote" as const, url: v.url, headers: v.headers, oauth: false as const, timeout: 20000 }]),
      ),
    },
    agent: {
      // Subagents for the task tool (several can run in parallel); see /subagents
      ...Object.fromEntries(
        listSubagents().map((a) => {
          const sm = a.model === "inherit" ? undefined : models.find((m) => m.id === a.model);
          return [
            a.name,
            {
              description: a.description,
              mode: "subagent",
              prompt: a.prompt,
              ...(sm ? { model: refString(sm) } : {}),
              // read-only agents: file reading only (no shell, no edits, no further delegation)
              ...opencodeAgentAccess(a, { editAllowed: allow, shell: shellAllowed() }),
            },
          ];
        }),
      ),
      [PLAN_AGENT]: {
        description: "Read-only investigation and planning",
        mode: "primary",
        prompt: PLAN_PROMPT,
        permission: { edit: "deny", bash: "deny" },
        // Denying edit and bash is not enough: `task` delegates to a subagent, and the write
        // ones (worker, tester, debugger) have both. Without this, plan mode fences the agent
        // and leaves the door to a deputy wide open — and swarm reviewers run in plan mode
        // precisely so a hostile repo cannot drive them into writing anything.
        // Same denial read-only subagents already get (opencodeAgentAccess).
        tools: { bash: false, task: false, edit: false, write: false, patch: false },
      },
    },
    permission: {
      edit: allow ? "allow" : "deny",
      // Shell only inside the sandbox (or when the host shell is explicitly allowed)
      bash: shellAllowed() ? "allow" : "deny",
      webfetch: "allow",
      // Second fence inside the sandbox: tools stay in the project workspace, plus the few shared paths skills need
      external_directory: {
        "*": "deny",
        "/tmp/*": "allow",
        [`${path.join(ROOT, "tools")}/*`]: "allow",
        [path.join(ROOT, "agent-readme.md")]: "allow",
        [`${path.join(ROOT, "help")}/*`]: "allow",
        [`${config.integrations.atlas.workflowsDir}/*`]: "allow",
        // read-only links from the user's computer (the mount itself refuses writes)
        ...(linksAvailable() ? { [`${LINKS_ROOT}/*`]: "allow" } : {}),
      },
      // Tools the Router endpoint wants a person to approve in the client (client approvals):
      // nobody can answer mid-turn here, so they are refused
      ...Object.fromEntries(routerMcp.flatMap((s) => s.deny.map((t) => [`${s.name}_${t}`, "deny"]))),
    },
  };
}

/** A free localhost port, so a leftover OpenCode from a previous run can never block startup. */
function freePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
  return tryPort(preferred).catch(() => tryPort(0));
}

/**
 * Secrets the OpenCode process must not inherit in its environ: it runs as our uid, and a
 * same-uid agent reads /proc/<pid>/environ (docs/THREAT-MODEL.md R1). What the engine's own
 * config legitimately needs (SayGM for models, Ditto for the MCP) travels in
 * OPENCODE_CONFIG_CONTENT; everything else ambient — APP_TOKEN, Hippius, and any vaulted
 * keys applyOverrides() put into process.env — stays out. GITHUB_TOKEN/TAOSTATS_API_KEY stay
 * by design (the agent gets them on purpose), and so does CATHEDRAL_API_KEY (tools/cathedral.mjs reads it).
 * Brief window: env is restored right after spawn.
 */
const ENGINE_ENV_BLOCKLIST = /^(APP_TOKEN|SAYGM_API_KEY|DITTO_API_KEY|DITTO_ROUTER_KEY|DITTO_ROUTER_REVIEW_KEY|ATLAS_API_KEY|TELEGRAM_BOT_TOKEN|HIPPIUS_.*)$/;

async function withScrubbedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (ENGINE_ENV_BLOCKLIST.test(k)) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function start(force = false): Promise<Running> {
  if (server && !force) return server;
  if (starting) return starting;
  starting = (async () => {
    if (server) {
      server.close();
      server = null;
    }
    const models = await chatModels(force);
    const [mcp] = await Promise.all([routerMcpServers(force), routerReview(force)]);
    const port = await freePort(config.agent.opencodePort);
    const { client, server: srv } = await withScrubbedEnv(() =>
      createOpencode({
        hostname: "127.0.0.1",
        port,
        timeout: 30000,
        config: buildConfig(models, mcp) as any,
      }),
    );
    const s: Running = { client, close: () => srv.close(), models: new Set(models.map((m) => m.id)), agents: subagentsSignature(), cfg: configVersion, mcp, router: routerSignature(mcp) };
    checkSubagentModels(s.models);
    server = s;
    pumped.clear();
    console.log(`[opencode] server up at ${srv.url} with ${models.length} models${mcp.length ? ` and ${mcp.length} Ditto MCP servers` : ""}`);
    return s;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** OpenCode scopes events to a directory (= project workspace): one stream per directory in use. */
const pumped = new Set<string>();
function ensurePump(client: OpencodeClient, directory: string) {
  if (pumped.has(directory)) return;
  pumped.add(directory);
  void pumpEvents(client, directory);
}

async function pumpEvents(client: OpencodeClient, directory: string) {
  while (server?.client === client) {
    try {
      const events = await client.event.subscribe({ query: { directory } });
      for await (const ev of events.stream as AsyncIterable<AnyEvent>) {
        const sid: string | undefined =
          ev.properties?.sessionID ?? ev.properties?.info?.sessionID ?? ev.properties?.part?.sessionID;
        if (!sid) continue;
        listeners.get(sid)?.forEach((fn) => fn(ev));
      }
    } catch (err) {
      if (server?.client !== client) return;
      console.error("[opencode] event stream dropped, reconnecting:", err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Ditto Router's error codes, by the HTTP status they come with. */
const ROUTER_ERRORS: Record<string, string> = {
  missing_api_key: "401", invalid_api_key: "401", expired_api_key: "401", revoked_api_key: "401", endpoint_deleted: "401",
  insufficient_balance: "402", spend_limit_exceeded: "402", key_spend_limit_exceeded: "402", endpoint_inactive: "402", byok_key_missing: "402",
  insufficient_scope: "403", endpoint_access_revoked: "403",
  unsupported_model: "404",
};

/**
 * Turn the gateway's terse HTTP errors into something actionable. Returns null for errors that
 * may be transient (network blips), which OpenCode is allowed to retry.
 */
export function gatewayHint(message: string, model: string, gateway?: ModelInfo["gateway"]): string | null {
  const router = gateway === "ditto-router";
  const routerCode = router ? Object.keys(ROUTER_ERRORS).find((c) => message.includes(c)) : undefined;
  const code = (routerCode && ROUTER_ERRORS[routerCode]) ?? message.match(/"code"\s*:\s*"?(\d{3})"?/)?.[1] ?? message.match(/\b(40[1-4]|429)\b/)?.[1];
  const name = router ? "Ditto Router" : "SayGM";
  switch (code) {
    case "402":
      return router
        ? `Ditto Router refused the request${routerCode ? ` (${routerCode})` : " (402)"} for ${model}. Check your Ditto credits, and the endpoint's spend limit and provider keys on developer.heyditto.ai, or switch model.`
        : `SayGM refused the request: payment required (402) for ${model}. Check your SayGM balance or whether your plan includes this model, or switch model.`;
    case "401":
      return router
        ? `Ditto Router rejected the endpoint key${routerCode ? ` (${routerCode})` : " (401)"}. Check the Router key in Settings → Integrations → Ditto.`
        : "SayGM rejected the API key (401). Check SAYGM_API_KEY in Settings → Integrations → SayGM.";
    case "403":
      return `${name} says this key isn't allowed to use ${model} (403).${router ? " Check the endpoint's model routes on developer.heyditto.ai." : ""}`;
    case "404":
      return `${name} doesn't know the model ${model} (404). Reload the model list in Settings and pick another.`;
    default:
      return null;
  }
}

/** Tiny push→pull queue so event callbacks can feed an async generator. */
function channel<T>() {
  const buf: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(v: T) {
      buf.push(v);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (buf.length) {
          yield buf.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

export const opencodeEngine: AgentEngine = {
  id: "opencode",
  label: "OpenCode",

  async *run(input: RunInput): AsyncIterable<AgentEvent> {
    // refuse before anything restarts: an unknown Router model must not restart OpenCode every turn
    const [known, mcp] = await Promise.all([chatModels().then((all) => all.find((m) => m.id === input.model)), routerMcpServers(), routerReview()]);
    const refusal = routerRefusal(input.model, known, input.plan);
    if (refusal) {
      yield { type: "error", message: refusal };
      yield { type: "done", engineSessionId: input.engineSessionId ?? "" };
      return;
    }
    let s = await start();
    if ((!s.models.has(input.model) || s.agents !== subagentsSignature() || s.cfg !== configVersion || s.router !== routerSignature(mcp)) && activeRuns === 0) {
      s = await start(true); // new model or Ditto tools, edited subagents or changed settings — reload OpenCode's config
    }
    const info: ModelInfo = known ?? { id: input.model, name: input.model, family: "other", api: "chat" };
    const dir = { directory: input.cwd };
    ensurePump(s.client, input.cwd);

    let sessionId = input.engineSessionId;
    if (!sessionId) {
      const created = await s.client.session.create({ body: {}, query: dir });
      if (!created.data) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      sessionId = created.data.id;
    }
    const sid = sessionId;

    const out = channel<AgentEvent>();
    const userMsgs = new Set<string>();
    const partKind = new Map<string, string>();
    const emitted = new Map<string, number>();
    const toolsStarted = new Set<string>();
    let usage: Usage = {};

    let lastTextPart: string | null = null;
    const emitText = (partID: string, kind: string, delta: string) => {
      if (!delta) return;
      if (kind !== "reasoning") {
        // Separate consecutive text blocks (e.g. before and after a tool call)
        if (lastTextPart && lastTextPart !== partID) out.push({ type: "text", delta: "\n\n" });
        lastTextPart = partID;
      }
      emitted.set(partID, (emitted.get(partID) ?? 0) + delta.length);
      out.push(kind === "reasoning" ? { type: "thinking", delta } : { type: "text", delta });
    };

    // the running total (this message plus subagents'), sent at most every few seconds
    let lastUsageAt = 0;
    let lastUsageOut = -1;
    const runningTotal = (): Usage => {
      let total = usage;
      for (const u of childUsage.values()) {
        total = {
          inputTokens: (total.inputTokens ?? 0) + (u.inputTokens ?? 0),
          cacheReadTokens: (total.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
          outputTokens: (total.outputTokens ?? 0) + (u.outputTokens ?? 0),
          costUsd: (total.costUsd ?? 0) + (u.costUsd ?? 0),
        };
      }
      return total;
    };
    const reportUsage = () => {
      const t = runningTotal();
      const now = Date.now();
      if (now - lastUsageAt < 3000 || (t.outputTokens ?? 0) === lastUsageOut) return;
      lastUsageAt = now;
      lastUsageOut = t.outputTokens ?? 0;
      out.push({ type: "usage", usage: t });
    };

    const onEvent: Listener = (ev) => {
      const p = ev.properties ?? {};
      switch (ev.type) {
        case "message.updated": {
          const m = p.info;
          if (m?.role === "user") userMsgs.add(m.id);
          if (m?.role === "assistant") {
            // Count cached prompt tokens too, otherwise cached turns show "2 in"
            const t = m.tokens ?? {};
            usage = {
              inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
              cacheReadTokens: t.cache?.read ?? 0,
              outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
              costUsd: m.cost,
            };
            reportUsage();
            if (m.error) {
              const raw = String(m.error.data?.message ?? m.error.name ?? "Model error");
              out.push({ type: "error", message: gatewayHint(raw, input.model, info.gateway) ?? raw });
            }
          }
          break;
        }
        case "message.part.delta": {
          if (userMsgs.has(p.messageID) || (p.field && p.field !== "text")) break;
          emitText(p.partID, partKind.get(p.partID) ?? "text", p.delta ?? "");
          break;
        }
        case "message.part.updated": {
          const part = p.part;
          if (!part || userMsgs.has(part.messageID)) break;
          partKind.set(part.id, part.type);
          if (part.type === "text" || part.type === "reasoning") {
            if (part.synthetic) break;
            const seen = emitted.get(part.id) ?? 0;
            if (seen === 0 && part.text === input.prompt) break; // echo of our own prompt
            if (typeof p.delta === "string" && p.delta) emitText(part.id, part.type, p.delta);
            else if (part.text.length > seen) emitText(part.id, part.type, part.text.slice(seen));
          } else if (part.type === "tool") {
            const st = part.state;
            if (!toolsStarted.has(part.callID) && st.status !== "pending") {
              toolsStarted.add(part.callID);
              out.push({ type: "tool_start", id: part.callID, name: part.tool, input: st.input });
            }
            // A subagent started: follow its child session so its tool calls show under this card
            const childSid = part.tool === "task" ? st.metadata?.sessionId : undefined;
            if (childSid && !children.has(childSid)) followChild(childSid, part.callID);
            if (st.status === "completed") out.push({ type: "tool_end", id: part.callID, output: String(st.output).slice(0, part.tool === "task" ? 20000 : 4000) });
            if (st.status === "error") out.push({ type: "tool_end", id: part.callID, output: st.error, isError: true });
          }
          break;
        }
        case "session.status": {
          const st = p.status;
          if (st?.type === "retry") {
            const hint = gatewayHint(String(st.message ?? ""), input.model, info.gateway);
            out.push({ type: "error", message: hint ?? `Model call failed, OpenCode retrying (attempt ${st.attempt}): ${st.message}` });
            // Billing/auth/model errors won't fix themselves: stop instead of retrying
            if (hint || st.attempt >= 2) s.client.session.abort({ path: { id: sid }, query: dir }).catch((e) => console.warn("[opencode] abort failed:", e));
          }
          break;
        }
        case "session.error": {
          const e = p.error;
          if (e?.name !== "MessageAbortedError") out.push({ type: "error", message: e?.data?.message ?? e?.name ?? "Session error" });
          break;
        }
        case "session.idle": {
          out.push({ type: "done", engineSessionId: sid, usage: runningTotal() });
          out.close();
          break;
        }
      }
    };

    // Subagent sessions: forward their tool calls tagged with the parent task call
    const children = new Map<string, Listener>();
    const childUsage = new Map<string, Usage>();
    const followChild = (childSid: string, parentCall: string) => {
      const seen = new Set<string>();
      const fn: Listener = (ev) => {
        if (ev.type === "message.updated") {
          // Subagent spend counts toward this turn's usage and cost
          const m = ev.properties?.info;
          if (m?.role === "assistant") {
            const t = m.tokens ?? {};
            childUsage.set(m.id, {
              inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0),
              cacheReadTokens: t.cache?.read ?? 0,
              outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
              costUsd: m.cost ?? 0,
            });
            reportUsage();
          }
          return;
        }
        if (ev.type !== "message.part.updated") return;
        const part = ev.properties?.part;
        if (part?.type !== "tool") return;
        const st = part.state;
        const id = `${childSid}:${part.callID}`;
        if (!seen.has(id) && st.status !== "pending") {
          seen.add(id);
          out.push({ type: "tool_start", id, name: part.tool, input: st.input, parent: parentCall });
        }
        if (st.status === "completed") out.push({ type: "tool_end", id, output: String(st.output).slice(0, 1500), parent: parentCall });
        if (st.status === "error") out.push({ type: "tool_end", id, output: st.error, isError: true, parent: parentCall });
        // nested subagents
        const grandchild = part.tool === "task" ? st.metadata?.sessionId : undefined;
        if (grandchild && !children.has(grandchild)) followChild(grandchild, parentCall);
      };
      children.set(childSid, fn);
      if (!listeners.has(childSid)) listeners.set(childSid, new Set());
      listeners.get(childSid)!.add(fn);
    };

    if (!listeners.has(sid)) listeners.set(sid, new Set());
    listeners.get(sid)!.add(onEvent);
    // never fire-and-forget: an unresponsive engine rejecting here is an unhandled rejection,
    // which ends the Node process (2026-11 swarm: qwen)
    const onAbort = () => s.client.session.abort({ path: { id: sid }, query: dir }).catch((e) => console.warn("[opencode] abort failed:", e));
    input.signal.addEventListener("abort", onAbort, { once: true });
    activeRuns++;

    try {
      const res = await s.client.session.promptAsync({
        path: { id: sid },
        query: dir,
        body: {
          model: ref(info, input.plan),
          system: input.systemPrompt,
          ...(input.plan ? { agent: PLAN_AGENT } : {}),
          // question needs an interactive answer this UI can't give yet; integrations off unless the project enables them
          tools: {
            question: false,
            // Plan mode stays read-only: no subagents (some of them can edit)
            ...(input.plan ? { task: false } : {}),
            ...Object.fromEntries(integrations().filter((i) => !input.mcp[i.id]).map((i) => [`${i.id}_*`, false])),
            // ...and no MCP tools at all. Denying edit and bash fences the filesystem, but MCP
            // tools reach OUT: ditto_save_memory writes into long-term memory that every later
            // chat trusts, and bitbull_request_network_access puts a consent card in front of the
            // owner worded by whatever the agent just read. Plan mode is where agents read hostile
            // things — swarm reviewers on contributor branches — so it gets none of them.
            // (2026-11 swarm, confirmed by both reviewers; was residual R-list item since the merge.)
            ...(input.plan
              ? {
                  "ditto_*": false,
                  "bitbull_*": false,
                  ...Object.fromEntries([...integrations().map((i) => i.id), ...s.mcp.map((m) => m.name)].map((n) => [`${n}_*`, false])),
                }
              : {}),
          },
          parts: [{ type: "text", text: input.prompt }],
        },
      });
      if (res.error) {
        yield { type: "error", message: `OpenCode prompt failed: ${JSON.stringify(res.error)}` };
        yield { type: "done", engineSessionId: sid };
        return;
      }
      for await (const ev of out) yield ev;
    } finally {
      activeRuns--;
      input.signal.removeEventListener("abort", onAbort);
      listeners.get(sid)?.delete(onEvent);
      for (const [c, fn] of children) listeners.get(c)?.delete(fn);
      // drop empty sets so the map doesn't grow by one key per session for the life of the process
      for (const k of [sid, ...children.keys()]) if (listeners.get(k)?.size === 0) listeners.delete(k);
    }
  },
};

export async function reloadOpencode() {
  if (activeRuns === 0) await start(true);
}

// Don't leave an orphaned `opencode serve` behind when this process exits (tsx watch restarts, Ctrl+C).
process.once("exit", () => server?.close());

export function stopOpencode() {
  server?.close();
  server = null;
}
