import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { assertConfig, config, paths, readFileOverrides, reloadConfig, writeOverrides, type EngineId } from "./config.js";
import "./log.js";
import { engines, isRunning } from "./agent.js";
import {
  abortTurn,
  activeTurnId,
  collectTurn,
  latestTurnId,
  resetStaleTurns,
  snapshot as snapshotTurn,
  startTurn,
  watch as watchTurn,
  type TurnRecord,
  type TurnStatus,
} from "./turns.js";
import { messages, projects, sessions, storedFiles, workspaceFor } from "./db.js";
import { insideWorkspace, mirrorFile, newEncryptionKey, resetStorage, restoreFile, resumeMirror, storageEnabled } from "./storage.js";
import { brand, brandAsset } from "./brand.js";
import { atlasWorkflows, integrations, probeIntegrations } from "./integrations.js";
import { dittoEnabled, listDittoTools, probeDitto, resetDitto } from "./ditto.js";
import { reloadOpencode, stopOpencode } from "./engines/opencode.js";
import { listModels, publicModels } from "./models.js";
import { describeSettings, status, updateSettings } from "./settings.js";
import { recent, record, subscribe, type Level } from "./activity.js";
import { exportJson, exportMarkdown } from "./export.js";
import { addApproval, decide, fromEgress, networkState, proxyCheck, revoke } from "./egress.js";
import { handleMcp, MCP_PATH, BITBOB_MCP_HEADER, mcpTokenOk } from "./mcp.js";
import { linksAvailable, listLinks } from "./links.js";
import { listRepos, repoDiffStat } from "./repos.js";
import { FOCUS, getSwarm, listSwarms, publicSwarm, startSwarm } from "./swarm.js";
import { lockVault, unlockVault, VAULT_KEYS, vaultExists, vaultFile, vaultKeys, vaultSet, vaultUnlocked } from "./vault.js";
import { listSkills, mirrorSkillsInto, syncSkills } from "./skills.js";

assertConfig();

const app = new Hono();
app.onError((err, c) => {
  if (err instanceof z.ZodError) return c.json({ error: "bad request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  console.error("[server]", err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

// ---------- auth: single owner bearer token (header; ?token= only for the SSE streams) ----------
function tokenOk(given: string | undefined) {
  if (config.allowNoAuth && !config.appToken) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.appToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use("/api/*", async (c, next) => {
  // Health and branding are public: the login screen has to render before there is a token.
  if (c.req.path === "/api/health" || c.req.path === "/api/brand" || c.req.path.startsWith("/api/brand/")) return next();
  const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  // ?token= only for the live streams (EventSource can't send headers); everything else
  // needs the header, so the token isn't left in logs and history by ordinary requests
  const streamOnly = c.req.method === "GET" && /^\/api\/(activity|sessions\/[^/]+)\/stream$/.test(c.req.path);
  if (!tokenOk(header ?? (streamOnly ? c.req.query("token") : undefined))) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// ---------- meta ----------
app.get("/api/health", (c) => c.json({ ok: true }));

/** Name, logos and colour overrides (see docs/BRANDING.md). Public: the login screen needs it. */
app.get("/api/brand", (c) => c.json(brand()));

const MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};
app.get("/api/brand/asset/:file", (c) => {
  const file = brandAsset(c.req.param("file"));
  if (!file) return c.json({ error: "not found" }, 404);
  // An SVG is served as a download-safe, script-free document: it is operator-supplied,
  // but it must not become a way to run script on the app's origin.
  return c.body(readFileSync(file), 200, {
    "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "public, max-age=300",
  });
});

app.get("/api/config", async (c) =>
  c.json({
    engines: Object.values(engines).map((e) => ({ id: e.id, label: e.label })),
    defaultEngine: config.agent.defaultEngine,
    defaultModel: config.agent.defaultModel,
    ditto: { enabled: dittoEnabled(), archive: config.ditto.archive },
  }),
);

app.get("/api/models", async (c) => c.json({ models: await publicModels(c.req.query("refresh") === "1") }));

app.post("/api/models/refresh", async (c) => {
  await listModels(true);
  await reloadOpencode();
  return c.json({ models: await publicModels() });
});

/** Effective configuration (secrets masked) for the Settings panel. */
app.get("/api/settings", (c) => c.json({ groups: describeSettings() }));
/** Live connection checks that cost no model tokens. */
/** Change settings from the UI (saved to DATA_DIR/settings.local.json, applied live). */
app.put("/api/settings", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { values?: Record<string, string | null> };
  if (!body.values || typeof body.values !== "object") return c.json({ error: "values required" }, 400);
  try {
    const changed = await updateSettings(body.values);
    void reloadOpencode().catch(() => {}); // restarts now if idle, otherwise before the next turn
    return c.json({ changed, groups: describeSettings() });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
app.get("/api/status", async (c) => c.json(await status()));

// ---------- network access (egress approvals) ----------
// Asked by squid's external ACL helper for every host not on egress/allowlist.txt.
// Not under /api (no APP_TOKEN in the proxy); only the egress container's address is answered.
app.get("/internal/egress/check", async (c) => {
  const remote = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  if (!(await fromEgress(remote))) return c.text("ERR", 403);
  return c.text(proxyCheck(c.req.query("host") ?? "") ? "OK" : "ERR");
});

// BitBob's own MCP server for the engines (loopback + startup token; see mcp.ts)
app.all(MCP_PATH, async (c) => {
  if (!mcpTokenOk(c.req.header(BITBOB_MCP_HEADER))) return c.json({ error: "unauthorized" }, 401);
  return handleMcp(c.req.raw);
});

app.get("/api/network", (c) => c.json(networkState()));

// ---------- read-only folder links (added from Windows with link.ps1; listed only) ----------
app.get("/api/links", (c) => c.json({ available: linksAvailable(), links: listLinks() }));
app.post("/api/network/requests/:id", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
  if (body.decision !== "host" && body.decision !== "domain" && body.decision !== "deny") return c.json({ error: "decision must be host, domain or deny" }, 400);
  const r = decide(c.req.param("id"), body.decision);
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json({ request: r, ...networkState() });
});
app.post("/api/network/approved", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { host?: string; scope?: string };
  const a = addApproval(String(body.host ?? ""), body.scope === "domain" ? "domain" : "host", "added in Settings");
  if (!a) return c.json({ error: "Not a valid domain name (no IPs, ports or paths)" }, 400);
  return c.json({ approval: a, ...networkState() });
});
app.delete("/api/network/approved/:host", (c) => {
  const scope = c.req.query("scope");
  revoke(c.req.param("host"), scope === "domain" || scope === "host" ? scope : undefined);
  return c.json(networkState());
});

// ---------- export a chat (for pasting into another agent) ----------
app.get("/api/sessions/:id/export", (c) => {
  const id = c.req.param("id");
  const format = c.req.query("format") ?? "md";
  if (format === "json") {
    const j = exportJson(id);
    return j ? c.json(j) : c.json({ error: "not found" }, 404);
  }
  const md = exportMarkdown(id, {
    tools: c.req.query("tools") !== "0",
    activity: c.req.query("activity") !== "0",
    outputLimit: Number(c.req.query("limit") ?? 2000) || 2000,
    exchange: c.req.query("exchange") || undefined,
    compact: c.req.query("compact") === "1",
  });
  if (!md) return c.json({ error: "not found" }, 404);
  return c.text(md, 200, { "content-type": "text/markdown; charset=utf-8" });
});

// ---------- activity feed ----------
app.get("/api/activity", (c) => {
  const q = c.req.query();
  return c.json({
    events: recent({
      after: q.after ? Number(q.after) : undefined,
      // an unknown level must not silently widen the filter
      level: q.level ? ((["debug", "info", "warn", "error"] as Level[]).includes(q.level as Level) ? (q.level as Level) : "error") : undefined,
      sessionId: q.sessionId || undefined,
      limit: q.limit ? Math.min(2000, Number(q.limit)) : 500,
    }),
  });
});

/** Live activity (SSE). The UI keeps one of these open for the panel and error alerts. */
app.get("/api/activity/stream", (c) =>
  streamSSE(c, async (stream) => {
    const after = Number(c.req.query("after") ?? 0);
    // Subscribe BEFORE reading the backlog, so nothing recorded while the backlog is being
    // written can fall in the gap; events already in the backlog are skipped by id.
    let closed = false;
    const queue: Array<{ id: number; data: string }> = [];
    let wake: (() => void) | null = null;
    const off = subscribe((e) => {
      queue.push({ id: e.id, data: JSON.stringify(e) });
      // a stalled client must not grow this without limit: keep the newest
      if (queue.length > 1000) queue.splice(0, queue.length - 1000);
      wake?.();
    });
    let sent = after;
    for (const e of recent({ after, limit: 200 })) {
      await stream.writeSSE({ data: JSON.stringify(e), id: String(e.id) });
      sent = Math.max(sent, e.id);
    }
    stream.onAbort(() => {
      closed = true;
      off();
      wake?.();
    });
    while (!closed) {
      if (!queue.length) {
        // heartbeat every 25s keeps proxies from closing the connection
        await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 25000))]);
        wake = null;
        if (!queue.length && !closed) await stream.writeSSE({ event: "ping", data: "" });
        continue;
      }
      const next = queue.shift()!;
      if (next.id <= sent) continue; // already sent as backlog
      sent = next.id;
      await stream.writeSSE({ data: next.data, id: String(next.id) });
    }
  }),
);

app.get("/api/skills", (c) => c.json({ skills: listSkills() }));
app.post("/api/skills/sync", async (c) => c.json({ skills: await syncSkills() }));
/** Connectivity self-test: what works, what doesn't, and the exact error. */
app.get("/api/debug", async (c) => {
  const auth = { Authorization: `Bearer ${config.saygm.apiKey}`, "content-type": "application/json" };
  const probe = async (name: string, url: string, body?: unknown, headers: Record<string, string> = auth) => {
    try {
      const res = await fetch(url, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      return { name, status: res.status, body: text.slice(0, 400) };
    } catch (e) {
      return { name, error: e instanceof Error ? `${e.name}: ${e.message} ${(e as any).cause ?? ""}` : String(e) };
    }
  };
  const tool = { type: "function", function: { name: "noop", description: "noop", parameters: { type: "object", properties: {} } } };
  const results = await Promise.all([
    probe("saygm models", `${config.saygm.openaiBaseUrl}/models`),
    probe("saygm chat+tools gpt-5.5", `${config.saygm.openaiBaseUrl}/chat/completions`, { model: "gpt-5.5", messages: [{ role: "user", content: "say ok" }], tools: [tool], max_completion_tokens: 50 }),
    probe("saygm responses+tools gpt-5.5", `${config.saygm.openaiBaseUrl}/responses`, { model: "gpt-5.5", input: "say ok", reasoning: { effort: "low" }, tools: [{ type: "function", name: "noop", parameters: { type: "object", properties: {} } }], max_output_tokens: 50 }),
    probe("saygm anthropic messages", `${config.saygm.anthropicBaseUrl}/v1/messages`, { model: "claude-haiku-4-5", max_tokens: 20, messages: [{ role: "user", content: "say ok" }] }, { "x-api-key": config.saygm.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }),
  ]);
  const gem = { contents: [{ role: "user", parts: [{ text: "say ok" }] }] };
  const gk = { "x-goog-api-key": config.saygm.apiKey, "content-type": "application/json" };
  const root = config.saygm.anthropicBaseUrl;
  results.push(
    ...(await Promise.all([
      probe("gemini v1beta x-goog", `${root}/v1beta/models/gemini-3.5-flash:generateContent`, gem, gk),
      probe("gemini v1 x-goog", `${root}/v1/models/gemini-3.5-flash:generateContent`, gem, gk),
      probe("gemini v1beta bearer", `${root}/v1beta/models/gemini-3.5-flash:generateContent`, gem),
      probe("gemini chat.completions", `${config.saygm.openaiBaseUrl}/chat/completions`, { model: "gemini-3.5-flash", messages: [{ role: "user", content: "say ok" }] }),
    ])),
  );
  const ditto = await probeDitto();
  const dittoInit = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };
  const dh = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  (ditto as any).variants = await Promise.all([
    probe("ditto bearer", config.ditto.mcpUrl, dittoInit, { ...dh, Authorization: `Bearer ${config.ditto.apiKey}` }),
    probe("ditto x-api-key", config.ditto.mcpUrl, dittoInit, { ...dh, "x-api-key": config.ditto.apiKey }),
    probe("ditto router models", "https://router.heyditto.ai/v1/models", undefined, { Authorization: `Bearer ${config.ditto.apiKey}` }),
  ]);
  const out = { saygm: results, ditto };
  console.log("[debug]", JSON.stringify(out));
  return c.json(out);
});

app.get("/api/ditto/tools", async (c) => c.json({ tools: await listDittoTools() }));

// ---------- projects ----------
const ProjectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(20000).optional(),
  color: z.string().max(20).optional(),
  integrations: z.array(z.enum(["atlas", "four04"])).optional(),
  dittoSync: z.boolean().optional(),
});
const projectOut = (p: ReturnType<typeof projects.get>) =>
  p && { ...p, integrations: projects.integrations(p), workspace: workspaceFor(p), dittoSync: !!p.ditto_sync, dittoSyncedAt: p.ditto_synced_at ?? null };

app.get("/api/projects", (c) => c.json({ projects: projects.list().map(projectOut) }));

app.post("/api/projects", async (c) => {
  const body = ProjectSchema.parse(await c.req.json());
  const p = projects.create(body);
  mirrorSkillsInto(workspaceFor(p));
  console.log(`[projects] created "${p.name}" -> ${p.dir}`);
  return c.json({ project: projectOut(p) }, 201);
});

app.patch("/api/projects/:id", async (c) => {
  const body = ProjectSchema.partial().parse(await c.req.json());
  const p = projects.update(c.req.param("id"), body);
  return p ? c.json({ project: projectOut(p) }) : c.json({ error: "not found" }, 404);
});

/**
 * Ditto sync for a project: a seed/refresh run in its own chat ("Ditto sync · <project>") that
 * reads the project's imported material and workspace and saves the durable facts to Ditto.
 * Turning sync on (PATCH dittoSync) also tells the agent to keep Ditto current on every turn.
 */
function dittoSyncPrompt(name: string) {
  return [
    `Ditto sync for project "${name}". Bring Ditto up to date with this project's record.`,
    `1. Search Ditto for what it already holds about "${name}" (search_memories, and search_subjects for the project) so you merge rather than duplicate.`,
    `2. Read, if present: uploads/claude-import/memory/ (Claude's memory files: lines tagged [stated] are things the owner said, untagged lines are what Claude found or did; keep that distinction as "Tom said" vs "Claude found"), uploads/claude-import/docs/, uploads/claude-import/INDEX.md, and any README or docs in the workspace.`,
    `3. For every durable fact, decision, preference, lesson, person, open question or current status, save one concise, self-contained memory with save_memory (source "bitbob", include "Project: ${name}"), using update_memory when a related memory already covers it. Skip chatter, secrets, keys and anything that looks like one.`,
    `4. Finish with a table of what you saved (memory, source file) and what you skipped as duplicates, and one line on what in this project Ditto still knows nothing about.`,
  ].join("\n");
}
app.post("/api/projects/:id/ditto-sync", async (c) => {
  const p = projects.get(c.req.param("id"));
  if (!p) return c.json({ error: "not found" }, 404);
  if (!dittoEnabled()) return c.json({ error: "Ditto is not configured (DITTO_API_KEY)" }, 400);
  const s = sessions.create({ title: `Ditto sync · ${p.name}`, engine: config.agent.defaultEngine as EngineId, model: config.agent.defaultModel, projectId: p.id });
  const { turnId } = startTurn(s, { prompt: dittoSyncPrompt(p.name), model: s.model });
  projects.update(p.id, { dittoSyncedAt: Date.now() });
  record({ level: "info", source: "ditto", sessionId: s.id, sessionTitle: s.title, message: `Ditto sync started for project "${p.name}"` });
  return c.json({ sessionId: s.id, turnId }, 201);
});

/** Deletes the project record only: its chats become unfiled and its workspace folder stays on disk. */
app.delete("/api/projects/:id", (c) => {
  projects.delete(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- integrations ----------
app.get("/api/integrations", async (c) =>
  c.json({
    integrations: integrations().map(({ mcp, env, ...rest }) => ({
      ...rest,
      hasMcp: !!mcp,
      env: env.map((e) => ({ key: e.key, label: e.label, set: !!e.value, value: e.secret ? (e.value ? `${e.value.slice(0, 4)}…${e.value.slice(-4)}` : "") : e.value })),
    })),
    atlasWorkflows: atlasWorkflows(),
    likenessPolicy: config.heritage.likenessPolicy,
  }),
);
app.get("/api/integrations/status", async (c) => c.json({ integrations: await probeIntegrations() }));

// ---------- sessions ----------
const EngineSchema = z.string().refine((e) => e in engines, { message: "unknown engine" });

app.get("/api/sessions", (c) => c.json({ sessions: sessions.list() }));

app.post("/api/sessions", async (c) => {
  const body = z
    .object({
      engine: EngineSchema.optional(),
      model: z.string().optional(),
      title: z.string().optional(),
      projectId: z.string().nullable().optional(),
    })
    .parse(await c.req.json().catch(() => ({})));
  const s = sessions.create({
    engine: (body.engine ?? config.agent.defaultEngine) as EngineId,
    model: body.model ?? config.agent.defaultModel,
    title: body.title,
    projectId: body.projectId && projects.get(body.projectId) ? body.projectId : null,
  });
  return c.json({ session: s }, 201);
});

app.get("/api/sessions/:id", (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  // turnId lets a client that was away re-attach to the stream and replay what it missed
  return c.json({ session: s, messages: messages.list(s.id), running: isRunning(s.id), turnId: latestTurnId(s.id) ?? null });
});

app.patch("/api/sessions/:id", async (c) => {
  const body = z
    .object({ title: z.string().min(1).optional(), projectId: z.string().nullable().optional() })
    .parse(await c.req.json());
  const cur = sessions.get(c.req.param("id"));
  if (!cur) return c.json({ error: "not found" }, 404);
  const patch: Parameters<typeof sessions.update>[1] = {};
  if (body.title) patch.title = body.title;
  if (body.projectId !== undefined && body.projectId !== cur.project_id) {
    if (body.projectId && !projects.get(body.projectId)) return c.json({ error: "unknown project" }, 400);
    patch.project_id = body.projectId;
    // New workspace = new engine session; the next turn replays history as context
    patch.engine_session_id = null;
  }
  return c.json({ session: sessions.update(cur.id, patch) });
});

app.delete("/api/sessions/:id", (c) => {
  abortTurn(c.req.param("id"));
  sessions.delete(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/abort", (c) => {
  abortTurn(c.req.param("id"));
  return c.json({ ok: true });
});

const MAX_UPLOAD = config.uploadMaxMb * 1024 * 1024;
// Refuse oversized requests before the body is read into memory (the per-file check below runs
// after parsing). Files dialog: one UI batch (<= 40 MB) or one big file; chat: up to 20 files
// of at most 25 MB each (the composer's own limit).
const tooBig = (c: Context) => c.json({ error: `Upload too large for one request (files up to ${config.uploadMaxMb} MB each)` }, 413);
const filesLimit = bodyLimit({ maxSize: Math.max(MAX_UPLOAD, 50 * 1024 * 1024) + 1024 * 1024, onError: tooBig });
const chatLimit = bodyLimit({ maxSize: 20 * Math.min(MAX_UPLOAD, 25 * 1024 * 1024) + 1024 * 1024, onError: tooBig });
const safeName = (n: string) => n.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "file";

/** Workspace of a project id, or the general workspace for "general". */
function workspaceOf(id: string) {
  if (id === "general") return paths.workspace;
  const p = projects.get(id);
  return p ? workspaceFor(p) : null;
}

/**
 * A safe path inside the workspace from user-supplied relative segments ("my-repo/src/a.ts").
 * Drops "..", ".", empty and drive-letter segments; refuses the engines' own .claude/.opencode dirs.
 */
function safeRel(...parts: string[]) {
  const segs = parts
    .join("/")
    .split(/[\\/]+/)
    .map((x) => x.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim())
    .filter((x) => x && x !== "." && x !== ".." && !/^[a-zA-Z]:$/.test(x));
  if (segs[0] === ".claude" || segs[0] === ".opencode") return null;
  return segs.join("/");
}

/**
 * Add local files or whole folders to a project's workspace, keeping their folder structure.
 * multipart: file (repeated), path (repeated, relative path for each file), target (folder, default "uploads").
 * The UI sends folders in batches, so each request stays small.
 */
app.post("/api/projects/:id/files", filesLimit, async (c) => {
  const ws = workspaceOf(c.req.param("id"));
  if (!ws) return c.json({ error: "project not found" }, 404);
  const body = await c.req.parseBody({ all: true });
  const files = ([] as unknown[]).concat(body["file"] ?? []).filter((f): f is File => f instanceof File);
  const rels = ([] as unknown[]).concat(body["path"] ?? []).map(String);
  const target = safeRel(String(body["target"] ?? "uploads")) ?? "uploads";
  const overwrite = String(body["overwrite"] ?? "") === "1";
  if (!files.length) return c.json({ error: "no files" }, 400);
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const [i, f] of files.entries()) {
    if (f.size > MAX_UPLOAD) return c.json({ error: `${f.name} is over ${config.uploadMaxMb} MB` }, 413);
    const rel = safeRel(target, rels[i] || f.name);
    if (!rel) return c.json({ error: "invalid path" }, 400);
    // lexical check plus realpath: a symlinked folder or file planted in the workspace by the
    // agent must not turn an upload into a write somewhere else
    let abs: string;
    try {
      abs = insideWorkspace(ws, rel);
    } catch {
      return c.json({ error: "invalid path" }, 400);
    }
    if (existsSync(abs) && !overwrite) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(await f.arrayBuffer()));
    saved.push(rel);
  }
  console.log(`[upload] ${saved.length} file(s) -> ${target} (${skipped.length} existing skipped)`);
  const id = c.req.param("id");
  const project = id === "general" ? undefined : projects.get(id);
  for (const rel of saved) {
    mirrorFile({
      projectId: project?.id ?? null,
      projectDir: project?.dir ?? null,
      projectName: project?.name,
      workspace: ws,
      relPath: rel.split(path.sep).join("/"),
    });
  }
  return c.json({ saved, skipped });
});

// ---------- import (conversations from another assistant) ----------
/**
 * Bring chats in from somewhere else (tools/import-claude-export.mjs): sessions + messages are
 * written straight into history with their original timestamps. Each conversation gets a
 * stable id from its source id, so re-running an import skips what is already here. No engine
 * session is attached; the next turn replays the history as context, like a moved chat.
 */
const ImportSchema = z.object({
  projectId: z.string().nullable().optional(),
  source: z.string().min(1).max(40).regex(/^[a-z0-9.-]+$/),
  conversations: z
    .array(
      z.object({
        id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/),
        title: z.string().max(200).optional(),
        createdAt: z.number().int().positive(),
        updatedAt: z.number().int().positive().optional(),
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().max(400_000),
              createdAt: z.number().int().positive(),
            }),
          )
          .max(5000),
      }),
    )
    .min(1)
    .max(50),
});
app.post("/api/import/conversations", bodyLimit({ maxSize: 64 * 1024 * 1024, onError: tooBig }), async (c) => {
  const body = ImportSchema.parse(await c.req.json());
  if (body.projectId && !projects.get(body.projectId)) return c.json({ error: "unknown project" }, 400);
  let imported = 0;
  let skipped = 0;
  let msgs = 0;
  for (const conv of body.conversations) {
    const id = `${body.source}-${conv.id}`.slice(0, 120);
    const ok = sessions.importRow({
      id,
      title: (conv.title ?? "").trim().slice(0, 200) || "Imported chat",
      engine: config.agent.defaultEngine as EngineId,
      model: config.agent.defaultModel,
      engine_session_id: null,
      project_id: body.projectId ?? null,
      created_at: conv.createdAt,
      updated_at: conv.updatedAt ?? conv.createdAt,
    });
    if (!ok) {
      skipped++;
      continue;
    }
    imported++;
    let t = conv.createdAt;
    for (const m of conv.messages) {
      // keep order even when the source has equal timestamps
      t = Math.max(t + 1, m.createdAt);
      messages.importRow({
        id: randomUUID(),
        session_id: id,
        role: m.role,
        content: m.content,
        model: m.role === "assistant" ? body.source : null,
        tools_json: null,
        usage_json: null,
        created_at: t,
      });
      msgs++;
    }
  }
  console.log(`[import] ${body.source}: ${imported} conversation(s), ${msgs} message(s), ${skipped} already here`);
  return c.json({ imported, skipped, messages: msgs });
});

// ---------- vault ----------
/**
 * Keys entered in the UI live in DATA_DIR/vault.json, AES-256-GCM, with a key the server never
 * stores: the owner's PC holds it (link helper, DPAPI) and the page sends it at unlock. While
 * locked, .env applies. Unlocking also moves any secrets still in settings.local.json into the
 * vault, so the agent-readable file ends up holding none.
 */
/** Secrets the UI saved while the vault was locked move into it as soon as it is open. */
function migrateSecretsIntoVault(): string[] {
  if (!vaultUnlocked()) return [];
  const cur = readFileOverrides();
  const moved = Object.keys(cur).filter((k) => VAULT_KEYS.has(k));
  if (moved.length) {
    for (const k of moved) {
      vaultSet(k, cur[k]);
      delete cur[k];
    }
    writeOverrides(cur);
    reloadConfig();
    record({ level: "info", source: "config", message: `Moved ${moved.join(", ")} out of settings.local.json into the vault` });
  }
  return moved;
}
app.get("/api/vault", (c) => {
  migrateSecretsIntoVault();
  return c.json({ unlocked: vaultUnlocked(), exists: vaultExists(), keys: vaultKeys(), file: vaultFile() });
});
app.post("/api/vault/unlock", async (c) => {
  const body = z.object({ key: z.string().min(64).max(64) }).parse(await c.req.json());
  let count: number;
  try {
    count = unlockVault(body.key);
  } catch (e) {
    record({ level: "warn", source: "config", message: `Vault unlock refused: ${e instanceof Error ? e.message : String(e)}` });
    return c.json({ error: "That key does not open the vault" }, 400);
  }
  const moved = migrateSecretsIntoVault();
  reloadConfig();
  resetDitto();
  resetStorage();
  await listModels(true).catch(() => []);
  record({ level: "info", source: "config", message: `Vault unlocked: ${count + moved.length} secret(s)${moved.length ? `, ${moved.length} moved out of settings.local.json` : ""}` });
  return c.json({ unlocked: true, keys: vaultKeys(), moved });
});
app.post("/api/vault/lock", async (c) => {
  lockVault();
  reloadConfig();
  resetDitto();
  resetStorage();
  record({ level: "info", source: "config", message: "Vault locked: .env values apply until the next unlock" });
  return c.json({ unlocked: false });
});

// ---------- QA swarm ----------
const SwarmSchema = z.object({
  sessionId: z.string().min(1),
  target: z.string().min(1).max(400),
  models: z.array(z.string().min(1).max(120)).min(1).max(2),
  focus: z.array(z.enum(FOCUS)).optional(),
});
app.post("/api/swarm", async (c) => {
  const body = SwarmSchema.parse(await c.req.json());
  if (activeTurnId(body.sessionId)) return c.json({ error: "This chat is already running a turn; wait for it to finish." }, 409);
  try {
    return c.json({ swarm: publicSwarm(startSwarm(body)) }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
app.get("/api/swarm", (c) => c.json({ swarms: listSwarms(c.req.query("sessionId") || undefined).map(publicSwarm) }));
app.get("/api/swarm/:id", (c) => {
  const s = getSwarm(c.req.param("id"));
  return s ? c.json({ swarm: publicSwarm(s) }) : c.json({ error: "not found" }, 404);
});

// ---------- storage (Hippius) ----------

/** What has been mirrored for a project, newest first. "general" = the unfiled workspace. */
app.get("/api/projects/:id/stored", (c) => {
  const id = c.req.param("id");
  if (id !== "general" && !projects.get(id)) return c.json({ error: "project not found" }, 404);
  return c.json({ files: storedFiles.list(id === "general" ? null : id), enabled: storageEnabled() });
});

/** Pull a stored file back into its workspace and verify its checksum. */
app.post("/api/stored/:id/restore", async (c) => {
  const row = storedFiles.get(c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "stored") return c.json({ error: "this file is not stored yet" }, 409);
  const ws = row.project_id ? workspaceOf(row.project_id) : paths.workspace;
  if (!ws) return c.json({ error: "the project this belongs to is gone" }, 409);
  try {
    const out = await restoreFile(row, ws);
    return c.json({ path: row.rel_path, verified: out.verified });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Try a failed upload again. */
app.post("/api/stored/:id/retry", (c) => {
  const row = storedFiles.get(c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const ws = row.project_id ? workspaceOf(row.project_id) : paths.workspace;
  if (!ws) return c.json({ error: "the project this belongs to is gone" }, 409);
  const project = row.project_id ? projects.get(row.project_id) : undefined;
  const queued = mirrorFile({
    projectId: row.project_id,
    projectDir: project?.dir ?? null,
    projectName: project?.name ?? row.project_name ?? undefined,
    workspace: ws,
    relPath: row.rel_path,
  });
  return queued ? c.json({ ok: true }) : c.json({ error: "could not queue it: storage off, or the local file is gone" }, 409);
});

/**
 * A fresh encryption key, for first-time setup. Returned once and never stored by this
 * route: the user saves it through Settings like any other value, and backs it up.
 */
app.post("/api/storage/key", (c) => c.json({ key: newEncryptionKey() }));

/** Git clones in a project's workspace: branch, status, branches (read-only; actions go via the agent). */
app.get("/api/projects/:id/repos", async (c) => {
  const ws = workspaceOf(c.req.param("id"));
  if (!ws) return c.json({ error: "project not found" }, 404);
  return c.json({ repos: await listRepos(ws) });
});
app.get("/api/projects/:id/repos/diff", async (c) => {
  const ws = workspaceOf(c.req.param("id"));
  if (!ws) return c.json({ error: "project not found" }, 404);
  const rel = safeRel(c.req.query("repo") ?? "");
  if (rel === null) return c.json({ error: "invalid path" }, 400);
  return c.json({ stat: await repoDiffStat(ws, rel || ".", c.req.query("base") || undefined) });
});

/** List one folder of a project's workspace (for the Files panel and picking an upload target). */
app.get("/api/projects/:id/files", (c) => {
  const ws = workspaceOf(c.req.param("id"));
  if (!ws) return c.json({ error: "project not found" }, 404);
  const rel = safeRel(c.req.query("dir") ?? "");
  if (rel === null) return c.json({ error: "invalid path" }, 400);
  const abs = path.join(ws, rel);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return c.json({ error: "invalid path" }, 400);
  // a symlinked folder inside the workspace must not list what lies outside it
  try {
    const real = realpathSync(abs);
    const realWs = realpathSync(ws);
    if (real !== realWs && !real.startsWith(realWs + path.sep)) return c.json({ error: "invalid path" }, 400);
  } catch {
    return c.json({ dir: rel, entries: [], container: abs, host: null });
  }
  // Where this folder really is, for anyone who wants to open it outside BitBob: inside the
  // container, and (when BitBob's data is a mounted host folder) the host's path to the same place.
  const container = abs;
  const hostData = process.env.BITBOB_HOST_DATA_DIR || "";
  const host = hostData && abs.startsWith(config.dataDir) ? hostData.replace(/[\\/]+$/, "") + abs.slice(config.dataDir.length) : null;
  if (!existsSync(abs)) return c.json({ dir: rel, entries: [], container, host });
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((d) => !(rel === "" && (d.name === ".claude" || d.name === ".opencode")))
    .map((d) => {
      const isDir = d.isDirectory();
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(path.join(abs, d.name));
        if (!isDir) size = st.size;
        mtime = st.mtimeMs;
      } catch {
        /* vanished */
      }
      return { name: d.name, dir: isDir, size, mtime };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return c.json({ dir: rel, entries, container, host });
});

/** Upload files into the agent's workspace so any engine/model can read them with its tools. */
app.post("/api/sessions/:id/files", chatLimit, async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = await c.req.parseBody({ all: true });
  const files = ([] as unknown[]).concat(body["file"] ?? []).filter((f): f is File => f instanceof File);
  if (!files.length) return c.json({ error: "no files" }, 400);
  const rel = path.join("uploads", s.id.slice(0, 8));
  const dir = path.join(workspaceFor(projects.get(s.project_id)), rel);
  mkdirSync(dir, { recursive: true });
  const saved: Array<{ name: string; path: string; size: number }> = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD) return c.json({ error: `${f.name} is over ${config.uploadMaxMb} MB` }, 413);
    let name = safeName(f.name);
    for (let i = 1; existsSync(path.join(dir, name)); i++) name = safeName(f.name).replace(/(\.[^.]*)?$/, `-${i}$1`);
    let dest: string;
    try {
      dest = insideWorkspace(workspaceFor(projects.get(s.project_id)), path.join(rel, name));
    } catch {
      return c.json({ error: "invalid upload folder" }, 400);
    }
    writeFileSync(dest, Buffer.from(await f.arrayBuffer()));
    saved.push({ name: f.name, path: path.posix.join("uploads", s.id.slice(0, 8), name), size: f.size });
  }
  console.log(`[upload] ${saved.length} file(s) -> ${rel}`);
  const project = projects.get(s.project_id);
  for (const f of saved) {
    mirrorFile({
      projectId: s.project_id,
      projectDir: project?.dir ?? null,
      projectName: project?.name,
      workspace: workspaceFor(project),
      relPath: f.path,
    });
  }
  return c.json({ files: saved });
});

const SendSchema = z.object({
  message: z.string().min(1),
  model: z.string().optional(),
  /** Workspace-relative paths returned by the upload endpoint */
  attachments: z.array(z.string()).max(20).optional(),
  /** Read-only planning turn */
  plan: z.boolean().optional(),
});

/**
 * Stream a turn's events over SSE, from `from` (the last seq the client has) onwards.
 * The turn itself runs in turns.ts, so closing this connection doesn't stop it: the same
 * stream can be re-opened later, or opened twice from two devices.
 */
function streamTurn(c: Parameters<typeof streamSSE>[0], turnId: string, from: number) {
  return streamSSE(c, async (stream) => {
    // Subscribe first, snapshot second, then drop duplicates: an event emitted between
    // the two would otherwise fall through the gap.
    const queue: TurnRecord[] = [];
    let ended: TurnStatus | null = null;
    let closed = false;
    let wake: (() => void) | null = null;
    const off = watchTurn(turnId, {
      event: (rec) => {
        queue.push(rec);
        wake?.();
      },
      end: (status) => {
        ended = status;
        wake?.();
      },
    });
    stream.onAbort(() => {
      closed = true;
      off();
      wake?.();
    });

    let sent = from;
    const write = async (rec: TurnRecord) => {
      if (rec.seq <= sent) return;
      sent = rec.seq;
      await stream.writeSSE({ event: rec.event.type, data: JSON.stringify(rec.event), id: String(rec.seq) });
    };
    try {
      const snap = snapshotTurn(turnId, from);
      if (!snap) {
        await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message: "unknown turn" }) });
        return;
      }
      for (const rec of snap.events) await write(rec);
      if (snap.status !== "running") ended = ended ?? snap.status;

      while (!closed && (queue.length || ended === null)) {
        if (!queue.length) {
          // heartbeat every 25s keeps proxies and tunnels from closing the connection
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 25000))]);
          wake = null;
          if (!queue.length && ended === null && !closed) await stream.writeSSE({ event: "ping", data: "" });
          continue;
        }
        await write(queue.shift()!);
      }
      if (!closed && ended !== null) {
        // A turn the server restarted through never yields `done`; say so rather than hang.
        if (ended === "interrupted") {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ type: "error", message: "Turn interrupted: the server restarted while it was running." }),
          });
        }
        // Tells the client this stream ended because the turn did, not because the
        // connection dropped: without it a client can't know whether to re-attach.
        await stream.writeSSE({ event: "end", data: JSON.stringify({ type: "end", status: ended, seq: sent }) });
      }
    } finally {
      off();
    }
  });
}

/**
 * Start a turn. Streams it by default (what the web UI does); `?stream=0` returns
 * `{turnId}` straight away for clients that attach with GET /stream instead.
 */
app.post("/api/sessions/:id/messages", async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = SendSchema.parse(await c.req.json());
  if (activeTurnId(s.id)) return c.json({ error: "This session is already running a turn." }, 409);
  const { turnId } = startTurn(s, { prompt: body.message, model: body.model ?? s.model, attachments: body.attachments, plan: body.plan });
  if (c.req.query("stream") === "0") return c.json({ turnId, sessionId: s.id });
  return streamTurn(c, turnId, 0);
});

/**
 * Attach (or re-attach) to a turn: `?from=<seq>` replays everything after that sequence
 * number and then follows live. Without `turnId` it picks the running turn, or the last one.
 */
app.get("/api/sessions/:id/stream", (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const turnId = c.req.query("turnId") || latestTurnId(s.id);
  if (!turnId) return c.json({ error: "no turn to attach to" }, 404);
  const from = Math.max(0, Number(c.req.query("from") ?? 0) || 0);
  return streamTurn(c, turnId, from);
});

/**
 * Simple programmatic API: one call, one JSON answer. Creates a session if none given.
 * curl -H "Authorization: Bearer $APP_TOKEN" -d '{"message":"hi"}' https://host/api/v1/chat
 */
app.post("/api/v1/chat", async (c) => {
  const body = SendSchema.extend({
    sessionId: z.string().optional(),
    engine: EngineSchema.optional(),
    projectId: z.string().optional(),
  }).parse(await c.req.json());
  const s =
    (body.sessionId && sessions.get(body.sessionId)) ||
    sessions.create({
      engine: (body.engine ?? config.agent.defaultEngine) as EngineId,
      model: body.model ?? config.agent.defaultModel,
      projectId: body.projectId && projects.get(body.projectId) ? body.projectId : null,
    });
  if (activeTurnId(s.id)) return c.json({ error: "This session is already running a turn." }, 409);
  const { turnId } = startTurn(s, { prompt: body.message, model: body.model ?? s.model, attachments: body.attachments, plan: body.plan });
  let text = "";
  const tools: string[] = [];
  const errors: string[] = [];
  let usage: unknown;
  const { events } = await collectTurn(turnId);
  for (const { event: ev } of events) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "tool_start") tools.push(ev.name);
    if (ev.type === "error") errors.push(ev.message);
    if (ev.type === "done") usage = ev.usage;
  }
  return c.json({ sessionId: s.id, turnId, text, tools, errors, usage });
});

// ---------- web UI ----------
if (existsSync(config.webDist)) {
  // The browser must not become a way round the egress proxy: a reply or brand.json the agent
  // controls could otherwise make the browser fetch https://evil/?<data>. Images and media may
  // only come from BitBob itself (or data: URIs); scripts only from BitBob; connections to BitBob and the
  // link helper on this PC; fonts from Google as index.html does.
  const CSP = [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' http://localhost:8790 http://127.0.0.1:8790",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.use("/*", async (c, next) => {
    await next();
    if (!c.req.path.startsWith("/api/")) c.header("content-security-policy", CSP);
  });
  const index = readFileSync(path.join(config.webDist, "index.html"), "utf8");
  // index.html must never be cached: it names the hashed bundle, and a stale copy after a deploy
  // keeps showing the old UI (the bundles themselves are content-hashed, so they may cache).
  const page = (c: Context) => c.html(index, 200, { "cache-control": "no-cache, no-store, must-revalidate" });
  app.get("/", page);
  app.get("/index.html", page);
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), config.webDist) }));
  app.get("*", page);
} else {
  app.get("/", (c) => c.text("BitBob API is running. Build the UI with `npm run build` to serve it here."));
}

// ---------- boot ----------
resetStaleTurns();
resumeMirror((projectId) => (projectId ? workspaceOf(projectId) : paths.workspace));
await syncSkills().catch((e) => console.error("[skills]", e));
const srv = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[server] BitBob listening on http://${info.address}:${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopOpencode();
    srv.close();
    process.exit(0);
  });
}
