/**
 * Cathedral sealed sandboxes (cathedral.computer), run by BitBull on the agent's behalf.
 *
 * What it is for: running and checking code, repos, files and folders the owner doesn't trust or
 * was given, in a sealed room (AMD SEV-SNP) away from the owner's keys, workspace and network.
 * Isolation, not confidentiality: commands and files pass Cathedral's API in plaintext on the way
 * to the room (docs/THREAT-MODEL.md R13), so the agent is told never to send secrets.
 *
 * Shape, the same as BitBull's other paid or outbound integrations (Leadpoet, Telegram):
 *
 *  - The key stays here. It is a vault setting; the engines never get it in their environment.
 *    The agent reaches Cathedral only through the tools on BitBull's local MCP route
 *    /mcp/cathedral (behind the startup token), and this module makes every call with the tested
 *    helper (tools/cathedral.mjs run()). The spend limit and the uncapped-key switch are .env-only,
 *    so nothing the agent's shell can write changes them.
 *  - Closed until set. cathedral.computer is not on the static allowlist; it is open in the proxy
 *    only while a key is set (addBuiltIn, as Telegram and Leadpoet do).
 *  - Per project. The tools answer only in chats of a project the owner ticked Cathedral for.
 *  - A real approval. Every create raises a card (size, hourly rate, lifetime, spend cap,
 *    internet on or off) and waits for the owner. In scheduled runs and Telegram messages nobody
 *    can approve, so create is refused there.
 *  - Named, logged uploads. Only a file the call names, inside the project's workspace, is sent,
 *    and each upload is logged to Activity with its path, size and SHA-256.
 *  - Only its own rooms. exec, upload, download and delete work on rooms this project created in
 *    this run of BitBull (the helper also checks the room's task label before a delete).
 *
 * Requests and rooms live in memory, like network approvals: anything kept in the data folder
 * could be edited by the agent.
 */
import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { record } from "./activity.js";
import { config, effectiveCathedralCap, ROOT } from "./config.js";
import { projects, sessions, workspaceFor, type ProjectRow, type SessionRow } from "./db.js";
import { addBuiltIn } from "./egress.js";
import { isUnattended, liveSessions, resolveSession } from "./mcp.js";

// ---------- the helper ----------

export interface HelperResult {
  code: number;
  out: Record<string, any>;
}
type RunFn = (argv: string[], deps: { env: Record<string, string | undefined>; fetch: typeof fetch; sleep: (ms: number) => Promise<void> }) => Promise<HelperResult>;

let runFn: RunFn | null = null;
let fetchFn: typeof fetch = (...a) => globalThis.fetch(...a);
let sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Tests: a fake network and no waiting. */
export function _setTransport(t: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
  if (t.fetch) fetchFn = t.fetch;
  if (t.sleep) sleepFn = t.sleep;
}

/** The environment the helper sees: built here, from settings the agent can't write. */
function helperEnv(): Record<string, string | undefined> {
  const c = config.integrations.cathedral;
  return {
    CATHEDRAL_API_KEY: c.apiKey,
    CATHEDRAL_API_URL: c.apiUrl,
    CATHEDRAL_MAX_SPEND_USD: c.maxSpendUsd,
    CATHEDRAL_ALLOW_UNCAPPED_KEY: c.allowUncapped ? "on" : "off",
  };
}

/** One helper command, with the key from the vault. The helper redacts the key from everything it returns. */
export async function helper(argv: string[]): Promise<HelperResult> {
  runFn ??= ((await import(pathToFileURL(path.join(ROOT, "tools", "cathedral.mjs")).href)) as { run: RunFn }).run;
  return runFn(argv, { env: helperEnv(), fetch: fetchFn, sleep: sleepFn });
}

export const cathedralReady = () => !!config.integrations.cathedral.apiKey;

function apiHost() {
  try {
    return new URL(config.integrations.cathedral.apiUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}
// No key, no route: the proxy lets Cathedral through only while a key is set.
addBuiltIn(() => (cathedralReady() ? [{ host: apiHost(), why: "Cathedral sandboxes" }] : []));

// ---------- which chat, which project ----------

export type Ctx = { sid: string; session: SessionRow; project: ProjectRow; workspace: string };

/** The chat a call came from, and its project, but only when that project has Cathedral ticked. */
export function contextFor(hint?: string): Ctx | string {
  if (!cathedralReady()) return "Cathedral is not set up: the owner adds a key in Settings, Integrations, Cathedral.";
  const sid = resolveSession(hint);
  if (!sid) {
    return liveSessions().length > 1
      ? "Several chats are running at once, so BitBull can't tell which one is asking. Try again when this chat is the only one running."
      : "BitBull can't tell which chat is asking.";
  }
  const session = sessions.get(sid);
  if (!session) return "BitBull can't tell which chat is asking.";
  const project = session.project_id ? projects.get(session.project_id) : undefined;
  if (!project || !projects.integrations(project).includes("cathedral")) {
    return "Cathedral is not switched on for this chat. The owner turns it on per project (project settings, Integrations, Cathedral); chats outside such a project can't use it.";
  }
  return { sid, session, project, workspace: workspaceFor(project) };
}

// ---------- tasks and rooms ----------

/** One task tag per chat: it labels the rooms the chat creates and keys every retry. */
const tasks = new Map<string, string>();
function taskFor(sessionId: string) {
  let t = tasks.get(sessionId);
  if (!t) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    t = "t" + Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join("");
    tasks.set(sessionId, t);
  }
  return t;
}

export interface Room {
  id: string;
  projectId: string;
  sessionId: string;
  task: string;
  size: string;
  internet: boolean;
  /** QA Hound and clean-machine rooms are the run's alone: the chat tools never reach them */
  purpose: CreatePurpose;
  createdAt: string;
  deletedAt?: string;
}
const rooms = new Map<string, Room>();

/** A room this project created, still known here. */
export function ownRoom(projectId: string, id: string): Room | string {
  const r = rooms.get(id);
  if (!r || r.projectId !== projectId) return `Sandbox ${id} was not created from this project in this run of BitBull, so it can't be used from here.`;
  if (r.purpose !== "chat") return `Sandbox ${id} belongs to a QA Hound run; only that run uses it.`;
  if (r.deletedAt) return `Sandbox ${id} has been deleted.`;
  return r;
}

// ---------- approvals ----------

export type CreatePurpose = "chat" | "qa-hound" | "clean-machine";
export type CreateStatus = "pending" | "approved" | "denied" | "expired";
export interface CreateRequest {
  id: string;
  purpose: CreatePurpose;
  sessionId?: string;
  sessionTitle?: string;
  projectId: string;
  projectName: string;
  size: string;
  /** vCPU / memory, as the catalog gives them, for the card */
  resources?: { cpu?: number; memory_gib?: number; disk_gib?: number } | null;
  hourlyRateUsd: string;
  lifetimeSeconds: number;
  /** what the room may hold against the key: the most it can cost */
  spendCapUsd: string;
  /** the .env limit per sandbox, for the card */
  limitUsd: string;
  internet: boolean;
  /** closed apart from these hosts (e.g. the package registries an install needs) */
  allowHosts: string[];
  reason: string;
  status: CreateStatus;
  createdAt: string;
  decidedAt?: string;
}

const WAIT_MS = Math.max(30, Number(process.env.CATHEDRAL_APPROVAL_TIMEOUT_S ?? 300)) * 1000;
const requests: CreateRequest[] = [];
const waiters = new Map<string, Array<(r: CreateRequest) => void>>();

export function listCreateRequests() {
  for (const r of requests) {
    if (r.status === "pending" && !waiters.get(r.id)?.length && Date.now() - Date.parse(r.createdAt) > WAIT_MS + 5000) {
      r.status = "expired";
      r.decidedAt = new Date().toISOString();
    }
  }
  return requests.slice(-50);
}

/** The owner's answer from the card. */
export function decideCreate(id: string, decision: "approve" | "deny"): CreateRequest | null {
  const r = requests.find((x) => x.id === id);
  if (!r) return null;
  if (r.status !== "pending") return r;
  r.status = decision === "approve" ? "approved" : "denied";
  r.decidedAt = new Date().toISOString();
  record({
    level: "info",
    source: "cathedral",
    message: `${r.status === "approved" ? "Approved" : "Denied"} a Cathedral sandbox: ${r.size}, ${r.lifetimeSeconds}s, up to $${r.spendCapUsd}, internet ${r.internet ? "on" : "off"}`,
    ...(r.sessionId ? { sessionId: r.sessionId, sessionTitle: r.sessionTitle } : {}),
  });
  for (const fn of waiters.get(id) ?? []) fn(r);
  waiters.delete(id);
  return r;
}

/** Raise the card and wait for the owner (or the timeout). */
async function waitForOwner(r: CreateRequest): Promise<CreateRequest | null> {
  requests.push(r);
  if (requests.length > 200) requests.splice(0, requests.length - 200);
  record({
    level: "warn",
    source: "cathedral",
    message: `Approve a Cathedral sandbox? ${r.size} at $${r.hourlyRateUsd}/h for ${Math.round(r.lifetimeSeconds / 60)} min, up to $${r.spendCapUsd}, internet ${r.internet ? "ON" : r.allowHosts.length ? `only ${r.allowHosts.join(", ")}` : "off"}`,
    detail: r.reason,
    ...(r.sessionId ? { sessionId: r.sessionId, sessionTitle: r.sessionTitle } : {}),
  });
  return new Promise((resolve) => {
    const list = waiters.get(r.id) ?? [];
    const done = (x: CreateRequest) => {
      clearTimeout(t);
      resolve(x);
    };
    list.push(done);
    waiters.set(r.id, list);
    const t = setTimeout(() => {
      const l = waiters.get(r.id);
      if (l) waiters.set(r.id, l.filter((f) => f !== done));
      if (r.status === "pending") {
        r.status = "expired";
        r.decidedAt = new Date().toISOString();
      }
      resolve(null);
    }, WAIT_MS);
  });
}

const OP_RE = /^[a-z0-9]{1,32}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface CreateInput {
  purpose: CreatePurpose;
  projectId: string;
  sessionId?: string;
  size: string;
  lifetimeSeconds: number;
  internet: boolean;
  /** closed apart from these hosts; never together with internet */
  allowHosts?: string[];
  reason: string;
  /** the idempotency name for this create (a-z, 0-9) */
  op: string;
  /** the chat's task tag; a QA Hound run passes its own */
  task?: string;
}

/**
 * Quote, ask the owner, then create. The hold is the quote at today's rate, and the helper still
 * refuses it above the .env limit or what the key has left. Never called for an unattended turn.
 */
export async function createRoom(input: CreateInput): Promise<Record<string, any>> {
  const project = projects.get(input.projectId);
  if (!project) return { ok: false, error: "no_project", message: "No such project." };
  if (input.internet && input.allowHosts?.length) return { ok: false, error: "usage", message: "Internet on, or a list of hosts, not both." };
  if (!OP_RE.test(input.op)) return { ok: false, error: "invalid_op", message: "op may only use a-z and 0-9, at most 32 characters" };
  const reason = String(input.reason ?? "").trim().slice(0, 600);
  if (!reason) return { ok: false, error: "reason_required", message: "Give a reason: one sentence the owner can judge." };
  const lifetime = String(Math.round(input.lifetimeSeconds));
  const quote = (await helper(["quote", "--size", input.size, "--lifetime", lifetime])).out;
  if (!quote.ok) return quote;
  const catalog = (await helper(["catalog"])).out;
  const resources = catalog.ok ? (catalog.sealed?.sizes ?? []).find((s: any) => s.template === input.size)?.resources ?? null : null;
  const session = input.sessionId ? sessions.get(input.sessionId) : undefined;
  const req: CreateRequest = {
    id: randomUUID(),
    purpose: input.purpose,
    sessionId: input.sessionId,
    sessionTitle: session?.title,
    projectId: project.id,
    projectName: project.name,
    size: input.size,
    resources,
    hourlyRateUsd: String(quote.hourly_rate_usd),
    lifetimeSeconds: Number(lifetime),
    spendCapUsd: String(quote.hold_usd),
    limitUsd: effectiveCathedralCap(config.integrations.cathedral.maxSpendUsd).toFixed(2),
    internet: input.internet,
    allowHosts: input.allowHosts ?? [],
    reason,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  const decided = await waitForOwner(req);
  if (!decided) return { ok: false, error: "no_answer", message: `No answer from the owner within ${Math.round(WAIT_MS / 60000)} minutes. Nothing was created. Tell the owner what you need the sandbox for.` };
  if (decided.status !== "approved") return { ok: false, error: "denied", message: "The owner said no. Nothing was created. Don't ask again for the same thing; carry on without it." };
  const task = input.task ?? (input.sessionId ? taskFor(input.sessionId) : taskFor(`project:${project.id}`));
  const argv = ["create", "--task", task, "--op", input.op, "--size", input.size, "--lifetime", lifetime, "--max-spend", req.spendCapUsd];
  if (input.internet) argv.push("--internet");
  else if (input.allowHosts?.length) argv.push("--allow", input.allowHosts.join(","));
  const out = (await helper(argv)).out;
  // a create that answered not-ready or failed can still name a room: track it so it can be deleted
  if (typeof out.sandbox_id === "string" && ID_RE.test(out.sandbox_id)) {
    rooms.set(out.sandbox_id, { id: out.sandbox_id, projectId: project.id, sessionId: input.sessionId ?? "", task, size: input.size, internet: input.internet, purpose: input.purpose, createdAt: new Date().toISOString() });
    record({
      level: out.ok ? "info" : "warn",
      source: "cathedral",
      message: out.ok ? `Cathedral sandbox ${out.sandbox_id} created (${input.size}, internet ${input.internet ? "on" : "off"})` : `Cathedral sandbox ${out.sandbox_id} did not come up (${out.error})`,
      ...(session ? { sessionId: session.id, sessionTitle: session.title } : {}),
    });
    // a QA Hound run gives up on a room that didn't come up: delete it rather than leave it to its lifetime
    if (!out.ok && input.purpose !== "chat") await deleteRoom(rooms.get(out.sandbox_id)!).catch(() => undefined);
  }
  return out;
}

/** Delete a room this module created; the helper checks its task label before sending the delete. */
export async function deleteRoom(room: Room): Promise<Record<string, any>> {
  const out = (await helper(["delete", room.id, "--task", room.task, "--op", "delete"])).out;
  if (out.ok) {
    room.deletedAt = new Date().toISOString();
    record({ level: "info", source: "cathedral", message: `Cathedral sandbox ${room.id} deleted` });
  }
  return out;
}

/** Register a room created outside the chat tools (QA Hound), so the same ownership rules apply. */
export function roomFor(id: string) {
  return rooms.get(id);
}

// ---------- named files inside the workspace ----------

const SECRET_NAME = /^\.env(\..*)?$/i;
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/**
 * A workspace-relative file the call names: inside the workspace after symlinks are resolved, a
 * regular file, not under .git and not a .env file. Returns the absolute path, or why not.
 */
export function namedFile(workspace: string, rel: string, mustExist: boolean): string | { error: string } {
  const clean = String(rel ?? "").replace(/\\/g, "/").trim();
  if (!clean || clean.startsWith("/") || clean.includes("\0") || clean.split("/").some((p) => p === ".." || p === "")) return { error: "Name one file by its path inside this project's workspace, e.g. src/app.py (no absolute paths, no ..)." };
  const parts = clean.split("/");
  if (parts.some((p) => p.toLowerCase() === ".git")) return { error: "Files under .git are never sent or written." };
  const base = parts[parts.length - 1];
  if (SECRET_NAME.test(base) && !ENV_TEMPLATES.has(base.toLowerCase())) return { error: `${base} holds secrets and is never sent or written.` };
  let wsReal: string;
  try {
    wsReal = realpathSync(workspace);
  } catch {
    return { error: "This project's workspace does not exist yet." };
  }
  const abs = path.resolve(wsReal, clean);
  const inside = (p: string) => p === wsReal || p.startsWith(wsReal + path.sep);
  if (mustExist) {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return { error: `${clean} does not exist in this workspace.` };
    }
    if (!inside(real)) return { error: `${clean} leads outside this workspace.` };
    // the same rules for the file a link leads to: a cloned repo can ship notes.txt -> ../.env
    const realParts = path.relative(wsReal, real).split(path.sep);
    if (realParts.some((p) => p.toLowerCase() === ".git")) return { error: `${clean} leads into .git, which is never sent.` };
    const realBase = realParts[realParts.length - 1];
    if (SECRET_NAME.test(realBase) && !ENV_TEMPLATES.has(realBase.toLowerCase())) return { error: `${clean} leads to ${realBase}, which holds secrets and is never sent.` };
    if (!statSync(real).isFile()) return { error: `${clean} is not a file. Name each file to send.` };
    return real;
  }
  // a file to write: its folder must exist inside the workspace, and the name must not be a link
  let dir: string;
  try {
    dir = realpathSync(path.dirname(abs));
  } catch {
    return { error: `The folder for ${clean} does not exist in this workspace.` };
  }
  if (!inside(dir)) return { error: `${clean} leads outside this workspace.` };
  const target = path.join(dir, path.basename(abs));
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return { error: `${clean} is a link; it is not written through.` };
  return target;
}

// ---------- QA Hound: one room, exec only, for the reviewers of one run ----------

interface Grant {
  sandboxId: string;
  task: string;
  sessionIds: Set<string>;
  until: number;
}
const grants = new Map<string, Grant>();
/** Let these reviewer chats run commands in this room (nothing else) until the run ends. */
export function grantRoom(sandboxId: string, task: string, sessionIds: string[], ms: number) {
  grants.set(sandboxId, { sandboxId, task, sessionIds: new Set(sessionIds), until: Date.now() + ms });
}
export function revokeRoom(sandboxId: string) {
  grants.delete(sandboxId);
}
/** The grant for a call, or why not: the caller has to be one of the run's reviewer chats. */
export function grantFor(sandboxId: string, hint?: string): Grant | string {
  const g = grants.get(sandboxId);
  if (!g || Date.now() > g.until) return "That sandbox is not open to this review.";
  // The Claude engine names the chat; OpenCode can't (its MCP servers are shared), so then it is
  // enough that one of this run's reviewers has a turn running. The room holds only a copy of the
  // target, network closed, and its id is a random UUID the reviewers are told.
  const ok = hint && sessions.get(hint) ? g.sessionIds.has(hint) : liveSessions().some((c) => g.sessionIds.has(c));
  if (!ok) return "Only the reviewers of the QA Hound run that created this sandbox can use it.";
  return g;
}

// ---------- the MCP tools ----------

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
void sha256;

function build(hint: string | undefined) {
  const server = new McpServer({ name: "cathedral", version: "1.0.0" });
  const ctx = () => contextFor(hint);
  const room = (c: Ctx, id: string) => (ID_RE.test(id) ? ownRoom(c.project.id, id) : "That is not a sandbox id.");

  server.registerTool(
    "quote",
    {
      title: "Price a sealed sandbox",
      description:
        "Cathedral sealed sandboxes are for running and checking code, repos and files the owner doesn't trust or was given, away from their keys, workspace and network. " +
        "This prices one: the sizes on sale, the hourly rate, and the hold for a lifetime. It creates nothing and spends nothing.",
      inputSchema: { size: z.string().describe("A sealed size, e.g. sealed-1x2"), lifetime_seconds: z.number().int().min(60).max(86400) },
    },
    async ({ size, lifetime_seconds }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const q = (await helper(["quote", "--size", size, "--lifetime", String(lifetime_seconds)])).out;
      const cat = (await helper(["catalog"])).out;
      return text({ ...q, catalog: cat.ok ? cat.sealed : cat });
    },
  );

  server.registerTool(
    "create",
    {
      title: "Create a sealed sandbox (the owner approves)",
      description:
        "Create a sealed sandbox. The owner sees a card with the size, hourly rate, lifetime, spend cap and whether internet is on, and must approve it; the call waits (a few minutes). " +
        "Not available in scheduled runs or from Telegram. Network is closed unless internet=true, which you ask for only when the owner asked for internet. " +
        "Never send secrets: commands and files pass Cathedral's API on the way to the room. Delete the sandbox when you are done.",
      inputSchema: {
        size: z.string().describe("A sealed size from quote, e.g. sealed-1x2"),
        lifetime_seconds: z.number().int().min(60).max(86400).describe("How long it may live; it is deleted at the end whatever happens"),
        internet: z.boolean().default(false).describe("Open internet in the room. Only when the owner asked for it."),
        reason: z.string().describe("One sentence the owner can judge: what will run there and why"),
        op: z.string().describe("A name for this create (a-z, 0-9). The same name never creates twice, so reuse it to retry."),
      },
    },
    async ({ size, lifetime_seconds, internet, reason, op }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      if (isUnattended(c.sid)) return text("Not from here: this is a scheduled run or a Telegram message, and nobody is at BitBull's screen to approve a sandbox. Nothing was created. Say what you would run; the owner can ask for it from a chat on screen.");
      return text(await createRoom({ purpose: "chat", projectId: c.project.id, sessionId: c.sid, size, lifetimeSeconds: lifetime_seconds, internet, reason, op }));
    },
  );

  server.registerTool(
    "exec",
    {
      title: "Run a command in a sandbox",
      description: "Run a shell command in a sandbox this chat's project created. Up to 45 seconds; use exec_start and exec_wait for longer. Never put secrets in a command.",
      inputSchema: {
        sandbox_id: z.string(),
        command: z.string().describe("A shell command, e.g. cd /work/src && python3 -m pytest -q"),
        op: z.string().describe("A name for this step (a-z, 0-9). The same name never runs twice; use a new one for a new step."),
        cwd: z.string().optional(),
        timeout_seconds: z.number().int().min(1).max(45).optional(),
      },
    },
    async ({ sandbox_id, command, op, cwd, timeout_seconds }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const r = room(c, sandbox_id);
      if (typeof r === "string") return text(r);
      const argv = ["exec", sandbox_id, "--task", r.task, "--op", op, "--cmd", command];
      if (cwd) argv.push("--cwd", cwd);
      if (timeout_seconds) argv.push("--timeout", String(timeout_seconds));
      return text((await helper(argv)).out);
    },
  );

  server.registerTool(
    "exec_start",
    {
      title: "Start a long command in a sandbox",
      description: "Start a command that may take up to 30 minutes; returns an exec_id for exec_wait.",
      inputSchema: { sandbox_id: z.string(), command: z.string(), op: z.string(), cwd: z.string().optional(), timeout_seconds: z.number().int().min(1).max(1800) },
    },
    async ({ sandbox_id, command, op, cwd, timeout_seconds }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const r = room(c, sandbox_id);
      if (typeof r === "string") return text(r);
      const argv = ["exec-bg", sandbox_id, "--task", r.task, "--op", op, "--cmd", command, "--timeout", String(timeout_seconds)];
      if (cwd) argv.push("--cwd", cwd);
      return text((await helper(argv)).out);
    },
  );

  server.registerTool(
    "exec_wait",
    {
      title: "Wait for a long command",
      description: "Wait for a command started with exec_start and get its exit code and output. Call again if it says still_running.",
      inputSchema: { sandbox_id: z.string(), exec_id: z.string(), timeout_seconds: z.number().int().min(1).max(540).default(300) },
    },
    async ({ sandbox_id, exec_id, timeout_seconds }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const r = room(c, sandbox_id);
      if (typeof r === "string") return text(r);
      return text((await helper(["exec-wait", sandbox_id, "--exec", exec_id, "--timeout", String(timeout_seconds)])).out);
    },
  );

  server.registerTool(
    "upload",
    {
      title: "Send one named file from the workspace to a sandbox",
      description:
        "Send one file from this project's workspace to /work/... in a sandbox. Name each file: no folders, no globs. Never .env files or anything under .git. " +
        "Each upload is logged for the owner with its path, size and SHA-256. To check whether an upload whose answer was lost landed, call again with check=true (it only reads back).",
      inputSchema: {
        sandbox_id: z.string(),
        file: z.string().describe("Path inside this project's workspace, e.g. repo/src/app.py"),
        path: z.string().describe("Where it goes in the sandbox, under /work/, e.g. /work/app.py"),
        op: z.string().describe("A name for this upload (a-z, 0-9)"),
        check: z.boolean().default(false),
      },
    },
    async ({ sandbox_id, file, path: dest, op, check }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const r = room(c, sandbox_id);
      if (typeof r === "string") return text(r);
      const abs = namedFile(c.workspace, file, true);
      if (typeof abs !== "string") return text({ ok: false, error: "file_refused", message: abs.error });
      const argv = ["put", sandbox_id, "--task", r.task, "--op", op, "--src", abs, "--path", dest];
      if (check) argv.push("--check");
      const out = (await helper(argv)).out;
      if (!check) {
        record({
          level: out.ok ? "info" : "warn",
          source: "cathedral",
          message: out.ok ? `Sent to Cathedral sandbox ${sandbox_id}: ${file} → ${dest} (${out.bytes} bytes, sha256 ${out.sha256})` : `Upload to Cathedral sandbox ${sandbox_id} failed: ${file} → ${dest} (${out.error})`,
          detail: out.sha256 ? `sha256 ${out.sha256}` : undefined,
          sessionId: c.sid,
          sessionTitle: c.session.title,
        });
      }
      return text(out);
    },
  );

  server.registerTool(
    "download",
    {
      title: "Bring one file back from a sandbox",
      description: "Copy one file from /work/... in a sandbox into this project's workspace. The folder must already exist; links are not written through.",
      inputSchema: { sandbox_id: z.string(), path: z.string().describe("/work/... in the sandbox"), to: z.string().describe("Path inside this project's workspace") },
    },
    async ({ sandbox_id, path: src, to }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const r = room(c, sandbox_id);
      if (typeof r === "string") return text(r);
      const abs = namedFile(c.workspace, to, false);
      if (typeof abs !== "string") return text({ ok: false, error: "file_refused", message: abs.error });
      const out = (await helper(["get", sandbox_id, "--path", src, "--out", abs])).out;
      if (out.ok) record({ level: "info", source: "cathedral", message: `From Cathedral sandbox ${sandbox_id}: ${src} → ${to} (${out.bytes} bytes, sha256 ${out.sha256})`, sessionId: c.sid, sessionTitle: c.session.title });
      return text(out.ok ? { ...out, out: to } : out);
    },
  );

  for (const [name, title, cmd] of [
    ["status", "A sandbox's state", "status"],
    ["receipts", "The receipt chain head", "receipts"],
    ["verify", "Check a sandbox's receipts", "verify"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description:
          name === "verify"
            ? "Check the sandbox's receipt chain and room receipts as Cathedral's verify route reports them. It also lists what it did not check (the AMD report and the approved build need the offline verifier)."
            : `${title} (a sandbox this project created).`,
        inputSchema: { sandbox_id: z.string() },
      },
      async ({ sandbox_id }) => {
        const c = ctx();
        if (typeof c === "string") return text(c);
        const own = rooms.get(sandbox_id);
        if (!ID_RE.test(sandbox_id) || own?.projectId !== c.project.id || own.purpose !== "chat") return text(`Sandbox ${sandbox_id} was not created from this project's chats in this run of BitBull.`);
        return text((await helper([cmd, sandbox_id])).out);
      },
    );
  }

  server.registerTool(
    "list",
    { title: "Sandboxes this project created", description: "The sandboxes this project created in this run of BitBull, and their state.", inputSchema: {} },
    async () => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const mine = [...rooms.values()].filter((r) => r.projectId === c.project.id && r.purpose === "chat");
      return text({ ok: true, sandboxes: mine.map((r) => ({ id: r.id, size: r.size, internet: r.internet, created_at: r.createdAt, deleted: !!r.deletedAt })) });
    },
  );

  server.registerTool(
    "delete",
    { title: "Delete a sandbox", description: "Delete a sandbox this project created. Do this when you are done with it.", inputSchema: { sandbox_id: z.string() } },
    async ({ sandbox_id }) => {
      const c = ctx();
      if (typeof c === "string") return text(c);
      const r = room(c, sandbox_id);
      if (typeof r === "string") return text(r);
      return text(await deleteRoom(r));
    },
  );

  // QA Hound reviewers: run commands in the one room their run created, nothing else
  server.registerTool(
    "review_exec",
    {
      title: "Run a command in this review's sealed sandbox",
      description:
        "Only in a QA Hound review with 'Run it in a sealed sandbox' ticked: run a shell command in the sealed room that holds a copy of the target (under /work/src), network closed. " +
        "Use it to run the target's tests or try what you suspect. Nothing else of the owner's is in the room.",
      inputSchema: {
        sandbox_id: z.string(),
        command: z.string(),
        op: z.string().describe("A new name for each step (a-z, 0-9)"),
        timeout_seconds: z.number().int().min(1).max(45).default(45),
      },
    },
    async ({ sandbox_id, command, op, timeout_seconds }) => {
      if (!ID_RE.test(sandbox_id)) return text("That is not a sandbox id.");
      const g = grantFor(sandbox_id, hint);
      if (typeof g === "string") return text(g);
      return text((await helper(["exec", sandbox_id, "--task", g.task, "--op", op, "--cmd", command, "--cwd", "/work/src", "--timeout", String(timeout_seconds)])).out);
    },
  );
  return server;
}

/** Stateless Streamable HTTP, as BitBull's own MCP server. */
export async function handleCathedralMcp(req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = build(req.headers.get("x-bitbull-session") ?? undefined);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close().catch(() => {});
  }
}

/** Tests. */
export function _resetCathedral() {
  requests.length = 0;
  waiters.clear();
  rooms.clear();
  tasks.clear();
  grants.clear();
  runFn = null;
}
