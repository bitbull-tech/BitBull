import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { config, paths } from "./config.js";
import { projects, sessions, workspaceFor } from "./db.js";
import { proxied, requestAccess } from "./egress.js";
import { execCapableConfig } from "./repos.js";
import { record } from "./activity.js";

/**
 * BitBob's own MCP server, attached to both engines as "bitbob": tools that need the user or the
 * server rather than the sandbox: request_network_access, and ditto_review (Ditto's own review
 * service on a repo in the workspace: the CLI runs here with the Ditto key, never in the agent's shell).
 *
 * Served by the main listener (the engines reach it at 127.0.0.1) and guarded by a token
 * minted at startup, never written anywhere. The token is not a boundary against the agent
 * itself (it is in its engine's config); it stops anything else from calling in. x-bitbob-session
 * is a hint for attribution, not an identity. The tools only ever *ask* the user.
 */

export const MCP_PATH = "/mcp/bitbob";
const TOKEN = randomBytes(24).toString("hex");
export const BITBOB_MCP_HEADER = "x-bitbob-internal";

/** Chats with a turn running right now (to say which chat a request came from). */
let runningSessions: () => string[] = () => [];
export function setRunningSessions(fn: () => string[]) {
  runningSessions = fn;
}

export const bitbobMcpEnabled = () => proxied();

/** Connection details for the engines; sessionId is added when the engine runs per chat. */
export function bitbobMcpServer(sessionId?: string): { url: string; headers: Record<string, string> } | null {
  if (!bitbobMcpEnabled()) return null;
  return {
    url: `http://127.0.0.1:${config.port}${MCP_PATH}`,
    headers: { [BITBOB_MCP_HEADER]: TOKEN, ...(sessionId ? { "x-bitbob-session": sessionId } : {}) },
  };
}

export function mcpTokenOk(given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function build(sessionHint: string | undefined) {
  const server = new McpServer({ name: "bitbob", version: "1.0.0" });
  server.registerTool(
    "request_network_access",
    {
      title: "Ask the user for network access",
      description:
        "Ask the user to let the sandbox reach a domain that the egress proxy refused (HTTP 403 from the proxy, 'CONNECT tunnel failed', 'Forbidden'). " +
        "Give the exact host and one sentence the user can judge: what you need from it and why. The call waits for the user's answer (up to a few minutes). " +
        "Only ask for domains the task really needs; never try to get round the proxy instead.",
      inputSchema: {
        domain: z.string().describe("Host name, e.g. api.example.com (a URL is fine; no IP addresses)"),
        reason: z.string().describe("Why you need it, in one sentence the user can judge"),
      },
    },
    async ({ domain, reason }) => {
      // Which chat is asking: the engine says so (Claude engine), or the only one running
      const live = runningSessions();
      const sid = sessionHint && sessions.get(sessionHint) ? sessionHint : live.length === 1 ? live[0] : undefined;
      const title = sid ? sessions.get(sid)?.title : undefined;
      const r = await requestAccess({ domain, reason, sessionId: sid, sessionTitle: title });
      return { content: [{ type: "text" as const, text: r.text }] };
    },
  );

  server.registerTool(
    "ditto_review",
    {
      title: "Ditto Review of a repo's working changes",
      description:
        "Send a repository's uncommitted (or staged, or since-a-base) changes to Ditto Review, an independent reviewer, and get its findings back as JSON. " +
        "Use it before proposing a commit or a PR, as a second opinion next to your own review. Nothing is committed, pushed or posted. " +
        "Prerequisites the owner controls: the repo's GitHub origin must be set up for Ditto Review in their Ditto workspace, and the Ditto key must have review access; " +
        "otherwise the tool returns the service's refusal, which you report rather than work around. preview=true is offline and only shows what would be sent.",
      inputSchema: {
        repo: z.string().describe("Workspace-relative path of the git clone, e.g. BitBob or my-repo ('.' for the workspace root if it is a clone)"),
        mode: z.enum(["working", "staged", "base"]).default("working").describe("working = staged+unstaged+untracked; staged = index only; base = everything since the merge base with `base`"),
        base: z.string().optional().describe("Branch or ref for mode=base, e.g. main"),
        profile: z.enum(["quick", "standard", "deep"]).default("quick"),
        preview: z.boolean().default(false).describe("Offline: list what would be uploaded, run nothing"),
      },
    },
    async ({ repo, mode, base, profile, preview }) => {
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
      const live = runningSessions();
      const sid = sessionHint && sessions.get(sessionHint) ? sessionHint : live.length === 1 ? live[0] : undefined;
      const session = sid ? sessions.get(sid) : undefined;
      const project = session?.project_id ? projects.get(session.project_id) : null;
      const ws = project ? workspaceFor(project) : paths.workspace;
      const rel = repo
        .split(/[\\/]+/)
        .filter((x) => x && x !== "." && x !== "..")
        .join("/");
      const dir = path.resolve(ws, rel);
      if (!(dir === ws || dir.startsWith(ws + path.sep)) || !existsSync(path.join(dir, ".git"))) return text(`"${repo}" is not a git clone in this workspace.`);
      // The CLI snapshots the tree with git, so the clone's own config would run as this server
      // (the same vector as the Repositories view). Refuse the same way, before spawning anything.
      const unsafe = await execCapableConfig(dir);
      if (unsafe.length)
        return text(
          `Refused: this clone's own git config sets ${unsafe.slice(0, 4).join(", ")}, which git would run as a command while capturing the diff. ` +
            `Tell the owner; do not work around it.`,
        );
      if (!config.ditto.apiKey) return text("Ditto is not configured (no DITTO_API_KEY), so Ditto Review is not available.");
      if (mode === "base" && !(base && /^[A-Za-z0-9._/@^~-]{1,120}$/.test(base) && !base.startsWith("-"))) return text("mode=base needs a plain ref name in `base`, e.g. main.");
      const args = ["review", "local", "--directory", dir, "--profile", profile, "--output", "json"];
      if (mode === "staged") args.push("--staged");
      if (mode === "base") args.push("--base", base!);
      if (preview) args.push("--preview");
      else args.push("--timeout", "900");
      const cliHome = path.join(config.dataDir, "ditto-cli");
      mkdirSync(cliHome, { recursive: true });
      record({ level: "info", source: "ditto", sessionId: sid, sessionTitle: session?.title, message: `Ditto Review ${preview ? "preview" : "started"}: ${rel || "."} (${mode}, ${profile})` });
      return await new Promise((resolve) => {
        execFile(
          "heyditto",
          args,
          {
            cwd: dir,
            timeout: preview ? 60_000 : 960_000,
            maxBuffer: 16 * 1024 * 1024,
            env: {
              PATH: process.env.PATH ?? "",
              // Its own HOME, and no user/system git config at all: $HOME is writable by the
              // agent (it shares this uid), so a planted ~/.gitconfig must not steer the git
              // the CLI runs. Nothing else of BitBob's environment is passed on.
              HOME: cliHome,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              // The reviewed repo's OWN config is the remaining gap (it beats global/nosystem):
              // neutralise its exec knobs with env-level config, which outranks repo config.
              GIT_CONFIG_PARAMETERS: "'core.fsmonitor=' 'diff.external=' 'core.pager=cat'",
              GIT_TERMINAL_PROMPT: "0",
              DITTO_API_KEY: config.ditto.apiKey,
              DITTO_CONFIG_DIR: path.join(cliHome, "config"),
              ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTPS_PROXY } : {}),
              ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
            },
          },
          (err, stdout, stderr) => {
            const out = String(stdout || "").trim();
            const errText = String(stderr || "").trim();
            if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
              resolve(text("The Ditto CLI (heyditto) is not installed in this image; ask the owner to deploy a build that includes it."));
              return;
            }
            const body = out || errText || (err ? err.message : "");
            const clipped = body.length > 30_000 ? body.slice(0, 30_000) + "\n…(truncated)" : body;
            resolve(text(err && !out ? `Ditto Review did not complete: ${clipped}` : clipped));
          },
        );
      });
    },
  );
  return server;
}

/** Stateless Streamable HTTP: a fresh server per request (tools keep their state in egress.ts). */
export async function handleMcp(req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = build(req.headers.get("x-bitbob-session") ?? undefined);
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // the response body is fully built (JSON mode), so the pair can go
    void server.close().catch(() => {});
  }
}
