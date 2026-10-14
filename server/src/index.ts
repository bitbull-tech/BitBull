import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { assertConfig, config, paths, type EngineId } from "./config.js";
import "./log.js";
import { abortRun, engines, isRunning, runTurn } from "./agent.js";
import { messages, projects, sessions, workspaceFor } from "./db.js";
import { atlasWorkflows, integrations, probeIntegrations } from "./integrations.js";
import { dittoEnabled, listDittoTools, probeDitto } from "./ditto.js";
import { reloadOpencode, stopOpencode } from "./engines/opencode.js";
import { listModels, publicModels } from "./models.js";
import { describeSettings, status, updateSettings } from "./settings.js";
import { recent, subscribe, type Level } from "./activity.js";
import { exportJson, exportMarkdown } from "./export.js";
import { listSkills, mirrorSkillsInto, syncSkills } from "./skills.js";

assertConfig();

const app = new Hono();

// ---------- auth: single owner bearer token (header, or ?token= for SSE/browser) ----------
function tokenOk(given: string | undefined) {
  if (config.allowNoAuth && !config.appToken) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(config.appToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/health") return next();
  const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!tokenOk(header ?? c.req.query("token"))) return c.json({ error: "unauthorized" }, 401);
  return next();
});

// ---------- meta ----------
app.get("/api/health", (c) => c.json({ ok: true }));

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
      level: (q.level as Level) || undefined,
      sessionId: q.sessionId || undefined,
      limit: q.limit ? Math.min(2000, Number(q.limit)) : 500,
    }),
  });
});

/** Live activity (SSE). The UI keeps one of these open for the panel and error alerts. */
app.get("/api/activity/stream", (c) =>
  streamSSE(c, async (stream) => {
    const after = Number(c.req.query("after") ?? 0);
    for (const e of recent({ after, limit: 200 })) await stream.writeSSE({ data: JSON.stringify(e), id: String(e.id) });
    let closed = false;
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const off = subscribe((e) => {
      queue.push(JSON.stringify(e));
      wake?.();
    });
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
      await stream.writeSSE({ data: queue.shift()! });
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
});
const projectOut = (p: ReturnType<typeof projects.get>) =>
  p && { ...p, integrations: projects.integrations(p), workspace: workspaceFor(p) };

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
  return c.json({ session: s, messages: messages.list(s.id), running: isRunning(s.id) });
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
  abortRun(c.req.param("id"));
  sessions.delete(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/sessions/:id/abort", (c) => {
  abortRun(c.req.param("id"));
  return c.json({ ok: true });
});

const MAX_UPLOAD = config.uploadMaxMb * 1024 * 1024;
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
app.post("/api/projects/:id/files", async (c) => {
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
    const abs = path.join(ws, rel);
    if (!abs.startsWith(ws + path.sep)) return c.json({ error: "invalid path" }, 400);
    if (existsSync(abs) && !overwrite) {
      skipped.push(rel);
      continue;
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(await f.arrayBuffer()));
    saved.push(rel);
  }
  console.log(`[upload] ${saved.length} file(s) -> ${target} (${skipped.length} existing skipped)`);
  return c.json({ saved, skipped });
});

/** List one folder of a project's workspace (for the Files panel and picking an upload target). */
app.get("/api/projects/:id/files", (c) => {
  const ws = workspaceOf(c.req.param("id"));
  if (!ws) return c.json({ error: "project not found" }, 404);
  const rel = safeRel(c.req.query("dir") ?? "") ?? "";
  const abs = path.join(ws, rel);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return c.json({ error: "invalid path" }, 400);
  if (!existsSync(abs)) return c.json({ dir: rel, entries: [] });
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((d) => !(rel === "" && (d.name === ".claude" || d.name === ".opencode")))
    .map((d) => {
      const isDir = d.isDirectory();
      let size = 0;
      try {
        if (!isDir) size = statSync(path.join(abs, d.name)).size;
      } catch {
        /* vanished */
      }
      return { name: d.name, dir: isDir, size };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return c.json({ dir: rel, entries });
});

/** Upload files into the agent's workspace so any engine/model can read them with its tools. */
app.post("/api/sessions/:id/files", async (c) => {
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
    writeFileSync(path.join(dir, name), Buffer.from(await f.arrayBuffer()));
    saved.push({ name: f.name, path: path.posix.join("uploads", s.id.slice(0, 8), name), size: f.size });
  }
  console.log(`[upload] ${saved.length} file(s) -> ${rel}`);
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

/** Streaming turn (Server-Sent Events). Used by the web UI. */
app.post("/api/sessions/:id/messages", async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = SendSchema.parse(await c.req.json());
  return streamSSE(c, async (stream) => {
    for await (const ev of runTurn(s, body.message, body.model ?? s.model, body.attachments, { plan: body.plan })) {
      await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    }
  });
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
  let text = "";
  const tools: string[] = [];
  const errors: string[] = [];
  let usage: unknown;
  for await (const ev of runTurn(s, body.message, body.model ?? s.model, body.attachments, { plan: body.plan })) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "tool_start") tools.push(ev.name);
    if (ev.type === "error") errors.push(ev.message);
    if (ev.type === "done") usage = ev.usage;
  }
  return c.json({ sessionId: s.id, text, tools, errors, usage });
});

// ---------- web UI ----------
if (existsSync(config.webDist)) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), config.webDist) }));
  const index = readFileSync(path.join(config.webDist, "index.html"), "utf8");
  app.get("*", (c) => c.html(index));
} else {
  app.get("/", (c) => c.text("SayGM Agent API is running. Build the UI with `npm run build` to serve it here."));
}

// ---------- boot ----------
await syncSkills().catch((e) => console.error("[skills]", e));
const srv = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[server] SayGM Agent listening on http://${info.address}:${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopOpencode();
    srv.close();
    process.exit(0);
  });
}
