import { pathToFileURL } from "node:url";
import { checkSubagentModels, listSubagents, READ_ONLY_BASH, subagentsSignature } from "../subagents.js";
import { createServer } from "node:net";
import path from "node:path";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { config, configVersion, paths, ROOT, shellAllowed } from "../config.js";
import { dittoMcpHeaders } from "../ditto.js";
import { allIntegrationMcps, integrations } from "../integrations.js";
import { listModels, type ModelApi, type ModelInfo } from "../models.js";
import type { AgentEngine, AgentEvent, RunInput, Usage } from "./types.js";

/**
 * Engine 2: OpenCode (open source, provider-agnostic agent runtime).
 * Talks to every SayGM model natively: Claude models via SayGM's Anthropic
 * endpoint (@ai-sdk/anthropic), everything else via SayGM's OpenAI-compatible
 * endpoint (@ai-sdk/openai-compatible). Tools, MCP (Ditto) and skills behave the
 * same regardless of model.
 */

/** One OpenCode provider per SayGM API shape, so every model speaks its native protocol. */
const PROVIDERS: Record<ModelApi, { id: string; npm: string; name: string; baseURL: () => string }> = {
  anthropic: { id: "saygm-anthropic", npm: "@ai-sdk/anthropic", name: "SayGM · Anthropic", baseURL: () => `${config.saygm.anthropicBaseUrl}/v1` },
  responses: { id: "saygm-openai", npm: "@ai-sdk/openai", name: "SayGM · OpenAI", baseURL: () => config.saygm.openaiBaseUrl },
  google: { id: "saygm-google", npm: "@ai-sdk/google", name: "SayGM · Google", baseURL: () => `${config.saygm.anthropicBaseUrl}/v1beta` },
  chat: { id: "saygm", npm: "@ai-sdk/openai-compatible", name: "SayGM", baseURL: () => config.saygm.openaiBaseUrl },
};

// Make the bundled `opencode` binary resolvable and keep its state in DATA_DIR.
process.env.PATH = `${path.join(ROOT, "server", "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`;
process.env.XDG_DATA_HOME = paths.opencodeData;
process.env.XDG_STATE_HOME = paths.opencodeData;
// Optional built-in tools (read by the opencode process at startup)
if (config.agent.webSearch) process.env.OPENCODE_ENABLE_EXA = "1";
if (config.agent.lsp) process.env.OPENCODE_EXPERIMENTAL_LSP_TOOL = "true";

/** Read-only planning agent (OpenCode's built-in "plan" agent asks for approvals, which this UI can't answer). */
const PLAN_AGENT = "gm-plan";
const PLAN_PROMPT = [
  "You are in PLAN MODE. Investigate with read-only tools (read, grep, glob, webfetch, memory search) and produce a plan.",
  "Do not edit files, write files or run commands that change anything.",
  "Finish with: the goal as you understand it, findings, a numbered step-by-step plan with the files involved, risks, and open questions for the user.",
].join(" ");

type AnyEvent = { type: string; properties?: any };
type Listener = (ev: AnyEvent) => void;

type Running = { client: OpencodeClient; close(): void; models: Set<string>; agents: string; cfg: number };
let server: Running | null = null;
let starting: Promise<Running> | null = null;
const listeners = new Map<string, Set<Listener>>();
let activeRuns = 0;

function providerFor(m: { api?: ModelApi; family: ModelInfo["family"] }) {
  let api: ModelApi = m.api ?? "chat";
  if (api === "anthropic" && !config.agent.opencodeClaudeNative) api = "chat";
  return PROVIDERS[api].id;
}

function buildConfig(models: ModelInfo[]) {
  type Entry = {
    name: string;
    limit?: { context: number; output: number };
    cost?: { input: number; output: number; cache_read?: number };
  };
  const byProvider: Record<string, Record<string, Entry>> = {};
  for (const m of models) {
    const entry: Entry = {
      name: m.name,
      ...(m.contextLength ? { limit: { context: m.contextLength, output: Math.min(32000, m.contextLength) } } : {}),
      // Live SayGM prices ($/Mtok) so OpenCode's own cost tracking is right
      ...(m.price ? { cost: { input: m.price.input, output: m.price.output, ...(m.price.cacheRead ? { cache_read: m.price.cacheRead } : {}) } } : {}),
    };
    (byProvider[providerFor(m)] ??= {})[m.id] = entry;
  }
  const allow = config.agent.permissionMode === "bypassPermissions";
  const def = models.find((m) => m.id === config.agent.defaultModel) ?? models.find((m) => m.api === "anthropic") ?? models[0];
  const small = models.find((m) => m.id === config.agent.smallModel) ?? models.find((m) => /haiku|mini|flash/i.test(m.id)) ?? def;
  const provider: Record<string, unknown> = {};
  for (const p of Object.values(PROVIDERS)) {
    if (!byProvider[p.id]) continue;
    provider[p.id] = { npm: p.npm, name: p.name, options: { baseURL: p.baseURL(), apiKey: config.saygm.apiKey }, models: byProvider[p.id] };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    // Keeps GM's credentials out of the agent's shell and out of tool output (agent/opencode-plugin)
    plugin: [pathToFileURL(path.join(ROOT, "agent", "opencode-plugin", "gm-guard.js")).href],
    share: "disabled" as const,
    model: def ? `${providerFor(def)}/${def.id}` : undefined,
    small_model: small ? `${providerFor(small)}/${small.id}` : undefined,
    enabled_providers: Object.keys(provider),
    provider,
    mcp: {
      ...(config.ditto.apiKey
        ? { ditto: { type: "remote" as const, url: config.ditto.mcpUrl, headers: dittoMcpHeaders(), oauth: false as const, timeout: 15000 } }
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
              ...(sm ? { model: `${providerFor(sm)}/${sm.id}` } : {}),
              permission: {
                edit: a.access === "write" && allow ? "allow" : "deny",
                // read-only agents: inspection and test commands only
                bash: !shellAllowed() ? "deny" : a.access === "write" ? "allow" : READ_ONLY_BASH,
                webfetch: "allow",
              },
            },
          ];
        }),
      ),
      [PLAN_AGENT]: {
        description: "Read-only investigation and planning",
        mode: "primary",
        prompt: PLAN_PROMPT,
        permission: { edit: "deny", bash: "deny" },
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
        [`${config.integrations.atlas.workflowsDir}/*`]: "allow",
      },
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

async function start(force = false): Promise<Running> {
  if (server && !force) return server;
  if (starting) return starting;
  starting = (async () => {
    if (server) {
      server.close();
      server = null;
    }
    const models = await listModels(force);
    const { client, server: srv } = await createOpencode({
      hostname: "127.0.0.1",
      port: await freePort(config.agent.opencodePort),
      timeout: 30000,
      config: buildConfig(models) as any,
    });
    const s: Running = { client, close: () => srv.close(), models: new Set(models.map((m) => m.id)), agents: subagentsSignature(), cfg: configVersion };
    checkSubagentModels(s.models);
    server = s;
    pumped.clear();
    console.log(`[opencode] server up at ${srv.url} with ${models.length} SayGM models`);
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

/**
 * Turn SayGM's terse HTTP errors into something actionable. Returns null for errors that
 * may be transient (network blips), which OpenCode is allowed to retry.
 */
export function gatewayHint(message: string, model: string): string | null {
  const code = message.match(/"code"\s*:\s*"?(\d{3})"?/)?.[1] ?? message.match(/\b(40[1-4]|429)\b/)?.[1];
  switch (code) {
    case "402":
      return `SayGM refused the request: payment required (402) for ${model}. Check your SayGM balance or whether your plan includes this model, or switch model.`;
    case "401":
      return "SayGM rejected the API key (401). Check SAYGM_API_KEY in Settings → Configuration.";
    case "403":
      return `SayGM says this key isn't allowed to use ${model} (403).`;
    case "404":
      return `SayGM doesn't know the model ${model} (404). Reload the model list in Settings and pick another.`;
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
    let s = await start();
    if ((!s.models.has(input.model) || s.agents !== subagentsSignature() || s.cfg !== configVersion) && activeRuns === 0) {
      s = await start(true); // new SayGM model, edited subagents or changed settings — reload OpenCode's config
    }
    const models = await listModels();
    const info = models.find((m) => m.id === input.model) ?? { family: "other" as const, api: "chat" as const };
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
              outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
              costUsd: m.cost,
            };
            if (m.error) {
              const raw = String(m.error.data?.message ?? m.error.name ?? "Model error");
              out.push({ type: "error", message: gatewayHint(raw, input.model) ?? raw });
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
            const hint = gatewayHint(String(st.message ?? ""), input.model);
            out.push({ type: "error", message: hint ?? `Model call failed, OpenCode retrying (attempt ${st.attempt}): ${st.message}` });
            // Billing/auth/model errors won't fix themselves: stop instead of retrying
            if (hint || st.attempt >= 2) void s.client.session.abort({ path: { id: sid }, query: dir });
          }
          break;
        }
        case "session.error": {
          const e = p.error;
          if (e?.name !== "MessageAbortedError") out.push({ type: "error", message: e?.data?.message ?? e?.name ?? "Session error" });
          break;
        }
        case "session.idle": {
          let total = usage;
          for (const u of childUsage.values()) {
            total = {
              inputTokens: (total.inputTokens ?? 0) + (u.inputTokens ?? 0),
              outputTokens: (total.outputTokens ?? 0) + (u.outputTokens ?? 0),
              costUsd: (total.costUsd ?? 0) + (u.costUsd ?? 0),
            };
          }
          out.push({ type: "done", engineSessionId: sid, usage: total });
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
              outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
              costUsd: m.cost ?? 0,
            });
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
    const onAbort = () => void s.client.session.abort({ path: { id: sid }, query: dir });
    input.signal.addEventListener("abort", onAbort, { once: true });
    activeRuns++;

    try {
      const res = await s.client.session.promptAsync({
        path: { id: sid },
        query: dir,
        body: {
          model: { providerID: providerFor(info), modelID: input.model },
          system: input.systemPrompt,
          ...(input.plan ? { agent: PLAN_AGENT } : {}),
          // question needs an interactive answer this UI can't give yet; integrations off unless the project enables them
          tools: {
            question: false,
            // Plan mode stays read-only: no subagents (some of them can edit)
            ...(input.plan ? { task: false } : {}),
            ...Object.fromEntries(integrations().filter((i) => !input.mcp[i.id]).map((i) => [`${i.id}_*`, false])),
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
