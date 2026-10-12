import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "./config.js";

/**
 * Registry of external services the agent can be wired to. Each integration is a
 * set of configuration points (env vars) plus, when available, an MCP server the
 * engines attach. Projects choose which integrations their chats get.
 *
 * Adding a service = one entry here. Engines read `mcpServersFor(project)`.
 */
export type IntegrationId = "atlas" | "four04";

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
}

export function integrations(): IntegrationDef[] {
  const a = config.integrations.atlas;
  const f = config.integrations.four04;
  return [
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
      name: "404.xyz (404—GEN)",
      blurb: "Text-to-3D generation (Bittensor 404—GEN). Plugins for Blender, Unity and Unreal.",
      docs: "https://www.404.xyz/plugin",
      env: [
        { key: "FOUR04_API_KEY", label: "API key", secret: true, value: f.apiKey },
        { key: "FOUR04_API_BASE", label: "API base URL", value: f.apiBase },
        { key: "FOUR04_MCP_URL", label: "MCP endpoint (if offered)", value: f.mcpUrl },
      ],
      mcp: f.mcpUrl ? { url: f.mcpUrl, headers: f.apiKey ? { Authorization: `Bearer ${f.apiKey}` } : {} } : undefined,
      configured: !!(f.apiBase || f.mcpUrl),
      notes:
        "404 has no public API documented yet; generation is via its Blender/Unity/Unreal plugins. These slots are ready for an API or MCP endpoint when 404 provides one. Until then the agent can use Atlas's own Image → 3D nodes.",
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
export async function probeIntegrations() {
  return Promise.all(
    integrations().map(async (i) => {
      if (!i.mcp) return { id: i.id, ok: false, configured: i.configured, detail: i.configured ? "Configured (no MCP endpoint)" : "Not configured" };
      try {
        const c = new Client({ name: "gm-agent-probe", version: "0.1.0" });
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
