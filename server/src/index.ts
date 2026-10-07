import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { assertConfig, config, type EngineId } from "./config.js";
import { abortRun, engines, isRunning, runTurn } from "./agent.js";
import { messages, sessions } from "./db.js";
import { dittoEnabled, listDittoTools } from "./ditto.js";
import { reloadOpencode, stopOpencode } from "./engines/opencode.js";
import { listModels } from "./models.js";
import { listSkills, syncSkills } from "./skills.js";

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

app.get("/api/models", async (c) => c.json({ models: await listModels(c.req.query("refresh") === "1") }));

app.post("/api/models/refresh", async (c) => {
  const models = await listModels(true);
  await reloadOpencode();
  return c.json({ models });
});

app.get("/api/skills", (c) => c.json({ skills: listSkills() }));
app.post("/api/skills/sync", async (c) => c.json({ skills: await syncSkills() }));
app.get("/api/ditto/tools", async (c) => c.json({ tools: await listDittoTools() }));

// ---------- sessions ----------
const EngineSchema = z.string().refine((e) => e in engines, { message: "unknown engine" });

app.get("/api/sessions", (c) => c.json({ sessions: sessions.list() }));

app.post("/api/sessions", async (c) => {
  const body = z
    .object({ engine: EngineSchema.optional(), model: z.string().optional(), title: z.string().optional() })
    .parse(await c.req.json().catch(() => ({})));
  const s = sessions.create({
    engine: (body.engine ?? config.agent.defaultEngine) as EngineId,
    model: body.model ?? config.agent.defaultModel,
    title: body.title,
  });
  return c.json({ session: s }, 201);
});

app.get("/api/sessions/:id", (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json({ session: s, messages: messages.list(s.id), running: isRunning(s.id) });
});

app.patch("/api/sessions/:id", async (c) => {
  const body = z.object({ title: z.string().min(1).optional() }).parse(await c.req.json());
  const s = sessions.update(c.req.param("id"), body);
  return s ? c.json({ session: s }) : c.json({ error: "not found" }, 404);
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

const SendSchema = z.object({ message: z.string().min(1), model: z.string().optional() });

/** Streaming turn (Server-Sent Events). Used by the web UI. */
app.post("/api/sessions/:id/messages", async (c) => {
  const s = sessions.get(c.req.param("id"));
  if (!s) return c.json({ error: "not found" }, 404);
  const body = SendSchema.parse(await c.req.json());
  return streamSSE(c, async (stream) => {
    for await (const ev of runTurn(s, body.message, body.model ?? s.model)) {
      await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    }
  });
});

/**
 * Simple programmatic API: one call, one JSON answer. Creates a session if none given.
 * curl -H "Authorization: Bearer $APP_TOKEN" -d '{"message":"hi"}' https://host/api/v1/chat
 */
app.post("/api/v1/chat", async (c) => {
  const body = SendSchema.extend({ sessionId: z.string().optional(), engine: EngineSchema.optional() }).parse(
    await c.req.json(),
  );
  const s =
    (body.sessionId && sessions.get(body.sessionId)) ||
    sessions.create({
      engine: (body.engine ?? config.agent.defaultEngine) as EngineId,
      model: body.model ?? config.agent.defaultModel,
    });
  let text = "";
  const tools: string[] = [];
  const errors: string[] = [];
  let usage: unknown;
  for await (const ev of runTurn(s, body.message, body.model ?? s.model)) {
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
