import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config, effectiveCathedralCap, githubTokenKind } from "./config.js";
import { redact } from "./activity.js";

/**
 * Registry of external services the agent can be wired to. Each integration is a
 * set of configuration points (env vars) plus, when available, an MCP server the
 * engines attach. Projects choose which integrations their chats get.
 *
 * Adding a service = one entry here. Engines read `mcpServersFor(project)`.
 */
export type IntegrationId = "atlas" | "four04" | "github" | "cathedral";

export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  blurb: string;
  docs: string;
  /** env var → description */
  env: Array<{ key: string; label: string; secret?: boolean; value: string }>;
  /** MCP endpoint, when this integration has one and is configured */
  mcp?: { url: string; headers: Record<string, string> };
  configured: boolean;
  notes?: string;
  /** Applies to every chat (not switched per project) */
  global?: boolean;
}

export function integrations(): IntegrationDef[] {
  const a = config.integrations.atlas;
  const f = config.integrations.four04;
  const g = config.integrations.github;
  const ca = config.integrations.cathedral;
  return [
    {
      id: "github",
      name: "GitHub",
      blurb: "Clone, pull, push and open PRs from the agent's shell (git + gh CLI).",
      docs: "https://github.com/settings/personal-access-tokens",
      env: [
        { key: "GITHUB_TOKEN", label: `Token (${githubTokenKind()})`, secret: true, value: g.token },
        { key: "GIT_USER_NAME", label: "Commit author name", value: g.userName || config.ownerName },
        { key: "GIT_USER_EMAIL", label: "Commit author email", value: g.userEmail },
      ],
      configured: !!g.token,
      global: true,
      notes:
        "Fine-grained tokens (github_pat_…) are recommended: grant only the repositories the agent works on, with Contents read/write (plus Pull requests if it should open PRs). Classic tokens (ghp_…) also work; give them the repo scope. The token reaches git through a credential helper and gh through GH_TOKEN; it is never written into a repository.",
    },
    {
      id: "cathedral",
      name: "Cathedral sandboxes",
      blurb: "Run code in an isolated sealed sandbox (AMD SEV-SNP) away from your computer, with signed receipts. The agent asks before it spends.",
      docs: "https://cathedral.computer",
      env: [
        { key: "CATHEDRAL_API_KEY", label: "API key (cat_sk_…)", secret: true, value: ca.apiKey },
        { key: "CATHEDRAL_MAX_SPEND_USD", label: "Most one sandbox may hold (USD)", value: effectiveCathedralCap(ca.maxSpendUsd).toFixed(2) },
        { key: "CATHEDRAL_ALLOW_UNCAPPED_KEY", label: "Allow a key with no spending cap", value: ca.allowUncapped ? "on" : "off" },
      ],
      configured: !!ca.apiKey,
      global: true,
      notes:
        "Use a key with its own spending cap: Cathedral enforces it on every create, and it is the backstop if the agent misbehaves. The agent runs everything through tools/cathedral.mjs (see the cathedral-sandbox skill), which keeps the network closed unless you ask for internet, holds to the spend limit above and deletes what it creates. Files and commands sent to a sandbox leave your computer.",
    },
    {
      id: "atlas",
      name: "Atlas AI Studio",
      blurb: "Node-graph studio for images, cinematic video (Higgsfield Cinema Studio, Grok Imagine, Seedance), 3D meshes, rigging and animation (UE5/Unity/Blender).",
      docs: "https://docs.atlas.design/atlas-ai-studio-overview/node-index/mcp",
      env: [
        { key: "ATLAS_API_KEY", label: "Workspace API key (atk_…)", secret: true, value: a.apiKey },
        { key: "ATLAS_MCP_URL", label: "MCP endpoint", value: a.mcpUrl },
        { key: "ATLAS_WORKFLOWS_DIR", label: "Exported workflow specs", value: a.workflowsDir },
      ],
      mcp: a.apiKey ? { url: a.mcpUrl, headers: { Authorization: `Bearer ${a.apiKey}` } } : undefined,
      configured: !!a.apiKey,
      notes:
        "MCP (alpha, enable per workspace with Atlas) lets the agent create/inspect projects, run the Atlas platform agent and manage exported APIs. Running a workflow is done through exported workflow APIs: drop each exported JSON spec into the workflows folder and the agent runs it with tools/atlas-run.mjs.",
    },
    {
      id: "four04",
      name: "404 (3D as code)",
      blurb: "Bittensor subnet 17: every 3D object is a Three.js module, made with the public 404 game recipe and checked by its own verifier and jam gate.",
      docs: f.recipeRepo,
      env: [
        { key: "FOUR04_MODEL_URL", label: "Open model endpoint (optional)", value: f.modelUrl },
        { key: "FOUR04_MODEL_KEY", label: "Open model key (optional)", secret: true, value: f.modelKey },
      ],
      // no 404 MCP and no 404 key: always ready, through the 404-game-recipe skill
      configured: true,
      global: true,
      notes:
        "Nothing to sign up for. The agent clones the public recipe (404-Repo/404-game-recipe), follows GAME.md for a game or 404.md for assets, checks every object with harness/verify.mjs, and runs the jam gate (harness/jam.mjs) against your own deployed URL. Jam entries go in as a pull request to 404-Repo/404-game-jam from your GitHub account (the GitHub card above). By default the agent writes the geometry itself: no account, key or GPU. Optional: the open model behind the leader of the 404 generation competition, deployed from 404's RunPod template on your own GPU; put its endpoint and VLLM_API_KEY here and stop the pod when you finish (it bills by the hour). For images and sound, Atlas (above) is what the jam used.",
    },
  ];
}

/** MCP servers to attach for a project's enabled integrations (only configured ones). */
export function mcpServersFor(enabled: IntegrationId[]): Record<string, { url: string; headers: Record<string, string> }> {
  const out: Record<string, { url: string; headers: Record<string, string> }> = {};
  for (const i of integrations()) {
    if (enabled.includes(i.id) && i.mcp) out[i.id] = i.mcp;
  }
  return out;
}

/** Every configured integration MCP (OpenCode registers all globally, then filters per prompt). */
export function allIntegrationMcps() {
  return mcpServersFor(integrations().map((i) => i.id));
}

/** Exported Atlas workflow specs available to the agent. */
export function atlasWorkflows() {
  const dir = config.integrations.atlas.workflowsDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      let title = f.replace(/\.json$/, "");
      let inputs: string[] = [];
      try {
        const spec = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        title = spec.name ?? spec.title ?? title;
        const params = spec.inputs ?? spec.parameters ?? spec.input_schema?.properties;
        if (params && typeof params === "object") inputs = Array.isArray(params) ? params.map((p: any) => p.name ?? String(p)) : Object.keys(params);
      } catch {
        /* unreadable spec: still list the file */
      }
      return { file: f, title, inputs };
    });
}

/** Live check: connect to each configured MCP and list its tools. No credits spent. */
async function probeGithub() {
  const t = config.integrations.github.token;
  if (!t) return { id: "github" as const, ok: false, configured: false, detail: "Not configured: set GITHUB_TOKEN in .env" };
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "User-Agent": "bitbull-agent" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { id: "github" as const, ok: false, configured: true, detail: `GitHub said ${res.status}: token invalid or expired` };
    const u = (await res.json()) as { login?: string };
    const scopes = res.headers.get("x-oauth-scopes");
    const left = res.headers.get("x-ratelimit-remaining");
    const access = scopes !== null ? `scopes: ${scopes || "none"}` : "repo access as set on the token";
    return { id: "github" as const, ok: true, configured: true, detail: `Signed in as ${u.login} · ${githubTokenKind()} · ${access} · ${left} API calls left this hour` };
  } catch (e) {
    return { id: "github" as const, ok: false, configured: true, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 404 needs nothing to be ready; when the optional open model is set, check the pod answers. */
async function probeFour04() {
  const f = config.integrations.four04;
  if (!f.modelUrl) return { id: "four04" as const, ok: true, configured: true, detail: "Ready: no key needed · the agent writes the geometry with the 404 game recipe" };
  try {
    const res = await fetch(`${f.modelUrl.replace(/\/+$/, "")}/models`, {
      headers: f.modelKey ? { Authorization: `Bearer ${f.modelKey}` } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) return { id: "four04" as const, ok: false, configured: true, detail: "The open model refused the key (401): check FOUR04_MODEL_KEY" };
    if (!res.ok) return { id: "four04" as const, ok: false, configured: true, detail: `The open model pod said ${res.status} (stopped, or still downloading its weights?)` };
    const j = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
    return { id: "four04" as const, ok: true, configured: true, detail: `Open model up: ${j.data?.[0]?.id ?? "answering"} · remember to stop the pod when you finish` };
  } catch {
    return { id: "four04" as const, ok: false, configured: true, detail: "The open model pod isn't answering (stopped?). The recipe still works without it." };
  }
}

type CathedralProbe = { id: "cathedral"; ok: boolean; configured: boolean; detail: string; level?: "red" | "amber" | "green" };

/**
 * Live check of the Cathedral key: reads the key's account (scopes, cap) and the sealed catalog.
 * Creates nothing and spends nothing. The key goes only to the two GET routes below, over https,
 * and no error text from the network is shown (the class of the error only).
 */
const CATHEDRAL_SOLD_OUT = new Set(["sealed_capacity_unavailable", "sealed_pool_throttled", "sealed_pool_unavailable", "sealed_pool_unreachable"]);

/** A plain non-negative amount ("5", "0.25", 1.5): the only thing a budget or balance may be. */
const plainAmount = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null;
  return typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null;
};

/** Everything the probe returns goes to the Settings page, so every string passes through redact(). */
export async function probeCathedral(): Promise<CathedralProbe> {
  const r = await probeCathedralRaw();
  return { ...r, detail: redact(r.detail) };
}

async function probeCathedralRaw(): Promise<CathedralProbe> {
  const c = config.integrations.cathedral;
  const out = (ok: boolean, detail: string, level: "red" | "amber" | "green" = ok ? "green" : "red"): CathedralProbe => ({ id: "cathedral", ok, configured: true, detail, level });
  if (!c.apiKey) return { id: "cathedral", ok: false, configured: false, detail: "Not configured: add an API key below" };
  if (!/^https:\/\//i.test(c.apiUrl)) return out(false, "CATHEDRAL_API_URL must be https, so the key is not sent");
  const get = (route: string) =>
    fetch(`${c.apiUrl}${route}`, { headers: { Authorization: `Bearer ${c.apiKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  try {
    const acct = await get("/v1/account");
    if (acct.status === 401) return out(false, "Cathedral refused the key (401): key refused or revoked");
    if (acct.status === 403) return out(false, "The key may not read its account (403): check its scopes");
    if (!acct.ok) return out(false, `Cathedral said ${acct.status} reading the account`);
    const a = (await acct.json().catch(() => ({}))) as { scopes?: unknown; api_key?: { budget_usd?: unknown; committed_usd?: unknown; remaining_usd?: unknown; expires_at?: unknown } | null };
    if (Array.isArray(a.scopes) && !a.scopes.includes("sandboxes:control")) return out(false, "This key cannot create sandboxes: it lacks the sandboxes:control scope");
    const k = a.api_key;
    const capped = !!k && k.budget_usd !== null && k.budget_usd !== undefined;
    // a budget that is not a plain amount is a malformed answer, not a cap (and not "uncapped" either)
    if (capped && (plainAmount(k!.budget_usd) === null || plainAmount(k!.remaining_usd) === null || (k!.committed_usd !== undefined && plainAmount(k!.committed_usd) === null))) {
      return out(false, "Cathedral's account answer is malformed (the key's budget or remaining amount is not a plain amount), so the cap cannot be trusted", "red");
    }
    if (!capped && !c.allowUncapped) return out(false, "This key has no spending cap; the integration will not create sandboxes. Use a capped key.", "red");

    const cat = await get("/v1/sandboxes/catalog");
    if (!cat.ok) return out(false, `Cathedral said ${cat.status} reading the catalog`);
    const body = (await cat.json().catch(() => ({}))) as { sealed?: { available?: boolean; reason?: string; sizes?: Array<{ template?: string; name?: string; hourly_rate_usd?: unknown }> } };
    const sealed = body.sealed;
    if (!sealed) return out(false, "Cathedral's catalog has no sealed offer");
    if (!sealed.available) {
      const reason = String(sealed.reason ?? "unavailable");
      // Cathedral's own sold-out set (SOLD_OUT_ERRORS in its broker): a full,
      // throttled, down or unreachable pool reads as sold out, never unavailable.
      return out(false, CATHEDRAL_SOLD_OUT.has(reason) ? "Sealed sandboxes are sold out right now" : `Sealed sandboxes are unavailable: ${reason}`);
    }
    const sizes = (sealed.sizes ?? []).map((s) => `${s.template ?? s.name} $${Number(s.hourly_rate_usd)}/h`).join(", ");
    const account = capped
      ? `cap $${Number(k!.budget_usd)}, committed $${Number(k!.committed_usd ?? 0)}, remaining $${Number(k!.remaining_usd ?? 0)}${k!.expires_at ? `, expires ${String(k!.expires_at).slice(0, 10)}` : ""}`
      : "no spending cap on this key (your switch allows it; the limit above applies)";
    return out(true, `Ready · ${account} · sizes: ${sizes || "none listed"}`, capped ? "green" : "amber");
  } catch (e) {
    return out(false, `Cathedral is not answering (${e instanceof Error ? e.name : "error"})`);
  }
}

export async function probeIntegrations() {
  return Promise.all(
    integrations().map(async (i) => {
      if (i.id === "github") return probeGithub();
      if (i.id === "four04") return probeFour04();
      if (i.id === "cathedral") return probeCathedral();
      if (!i.mcp) return { id: i.id, ok: false, configured: i.configured, detail: i.configured ? "Configured (no MCP endpoint)" : "Not configured" };
      try {
        const c = new Client({ name: "bitbull-agent-probe", version: "0.1.0" });
        await c.connect(new StreamableHTTPClientTransport(new URL(i.mcp.url), { requestInit: { headers: i.mcp.headers } }));
        const { tools } = await c.listTools();
        await c.close();
        return { id: i.id, ok: true, configured: true, detail: `${tools.length} MCP tools`, tools: tools.map((t) => t.name) };
      } catch (e) {
        return { id: i.id, ok: false, configured: true, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      }
    }),
  );
}
