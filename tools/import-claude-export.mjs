#!/usr/bin/env node
/**
 * Bring a Claude.ai account export into BitBull: projects (name, instructions, docs, Claude's
 * memory files for the project), conversations (as chats, with their original dates), the
 * account-level memory, and artifacts.
 *
 *   node tools/import-claude-export.mjs <zip | folder> [more zips/folders…]
 *        [--gm http://localhost:8787] [--token <APP_TOKEN>]
 *        [--projects-only | --conversations-only] [--project "<name>"] [--since 2026-01-01]
 *        [--include-starter] [--no-artifacts] [--dry-run]
 *
 * Get the export from claude.ai: Settings → Privacy → Export data. Anthropic emails a manifest
 * with links to several zips (projects-000.zip, conversations-000.zip, memories-000.zip,
 * frames-000.zip, light_metadata-000.zip; big accounts get -001, -002…). Download them all into
 * one folder and point this script at the folder (or list the zips). Safe to re-run: projects are
 * matched by name, conversations by their Claude id, files are not overwritten.
 *
 * Where things go:
 *   projects/*.json      → BitBull projects (description + instructions); each doc to
 *                          uploads/claude-import/docs/ in that project's workspace
 *   memories/*.json      → Claude's memory: per-project files and the project memory summary to
 *                          that project's uploads/claude-import/memory/; account-level files and the
 *                          conversations memory to the general workspace's uploads/claude-import/memory/
 *   conversations.json   → chats; the export does not say which project a chat belongs to, so they
 *                          are unfiled unless --project "<name>" files them all under one
 *   artifacts/*          → the general workspace's uploads/claude-import/artifacts/<id>/ (skip: --no-artifacts)
 *   Attachments' extracted text is kept with the message; images are named only.
 *
 * The token is read from --token, GM_APP_TOKEN, or APP_TOKEN in the repo's .env (never printed).
 * Nothing is sent anywhere except the BitBull URL. Needs Node 20+.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const one = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const VALUED = new Set(["--gm", "--token", "--project", "--since"]);
const inputs = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""));
if (!inputs.length || flag("help")) {
  console.log("usage: node tools/import-claude-export.mjs <zip|folder> [more…] [--gm url] [--token t] [--projects-only|--conversations-only] [--project name] [--since YYYY-MM-DD] [--include-starter] [--no-artifacts] [--dry-run]");
  process.exit(inputs.length ? 0 : 2);
}
const GM = (one("gm", process.env.GM_URL ?? "http://localhost:8787")).replace(/\/+$/, "");
const DRY = flag("dry-run");
const SINCE = one("since", "") ? Date.parse(one("since", "")) : 0;

function readToken() {
  const t = one("token", process.env.GM_APP_TOKEN);
  if (t) return t;
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  for (const env of [path.join(here, "..", ".env"), path.join(process.cwd(), ".env")]) {
    if (!existsSync(env)) continue;
    const m = /^\s*APP_TOKEN\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(env, "utf8"));
    if (m) return m[1].trim();
  }
  return "";
}
const TOKEN = readToken();
if (!TOKEN && !DRY) {
  console.error("No token: pass --token, set GM_APP_TOKEN, or run from the repo (reads APP_TOKEN from .env).");
  process.exit(2);
}

// ---------- reading the export (zip or folder) ----------

/** Minimal zip reader: central directory → entries → inflateRaw. Enough for Anthropic's export. */
function readZip(file) {
  const buf = readFileSync(file);
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    out.set(name, () => (method === 8 ? zlib.inflateRawSync(data) : method === 0 ? data : (() => { throw new Error(`unsupported zip method ${method} for ${name}`); })()));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Every file from every zip/folder given, as name → () => Buffer. Zips inside a folder are read too. */
function loadFiles(srcs) {
  const files = new Map();
  const addZip = (f) => {
    for (const [name, get] of readZip(f)) files.set(name.replace(/^\/+/, ""), get);
  };
  const addDir = (dir, depth) => {
    for (const n of readdirSync(dir)) {
      const f = path.join(dir, n);
      const st = statSync(f);
      if (st.isDirectory()) {
        if (depth < 6) addDir(f, depth + 1);
      } else if (/\.zip$/i.test(n) && /(conversations|projects|memories|frames|light_metadata)-\d+\.zip$/i.test(n)) addZip(f);
      else files.set(path.relative(srcs.root, f).split(path.sep).join("/"), () => readFileSync(f));
    }
  };
  for (const src of srcs.list) {
    if (statSync(src).isDirectory()) {
      srcs.root = src;
      addDir(src, 0);
    } else addZip(src);
  }
  return files;
}

function loadExport(list) {
  const files = loadFiles({ list, root: list[0] });
  const json = (get) => JSON.parse(get().toString("utf8"));
  const conversations = [];
  const projects = [];
  const memories = [];
  const artifacts = new Map(); // id -> { meta, files: [{rel, get, bytes}] }
  for (const [name, get] of files) {
    const base = path.posix.basename(name);
    if (base === "conversations.json" || /^conversations-\d+\.json$/.test(base)) {
      const v = json(get);
      conversations.push(...(Array.isArray(v) ? v : []));
    } else if (base === "projects.json") {
      const v = json(get);
      projects.push(...(Array.isArray(v) ? v : []));
    } else if (/(^|\/)projects\/[^/]+\.json$/.test(name)) {
      projects.push(json(get));
    } else if (/(^|\/)memories\/[^/]+\.json$/.test(name)) {
      memories.push(json(get));
    } else {
      const m = /(^|\/)artifacts\/([^/]+)\/(.+)$/.exec(name);
      if (m) {
        const [, , id, rel] = m;
        if (!artifacts.has(id)) artifacts.set(id, { meta: null, files: [] });
        const a = artifacts.get(id);
        if (rel === "artifact.json") a.meta = json(get);
        else a.files.push({ rel, get, bytes: get().length });
      }
    }
  }
  return { conversations, projects, memories, artifacts };
}

// ---------- shaping ----------

const when = (s) => {
  const t = Date.parse(s ?? "");
  return Number.isFinite(t) ? t : Date.now();
};

/** One Claude message → BitBull {role, content}. Text parts joined; attachments' text kept. */
function shapeMessage(m) {
  const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
  if (!role) return null;
  const parts = [];
  if (Array.isArray(m.content) && m.content.length) {
    for (const c of m.content) {
      if (c?.type === "text" && c.text) parts.push(c.text);
      else if (c?.type === "tool_use") parts.push(`_(used tool${c.name ? ` ${c.name}` : ""})_`);
      else if (c?.type === "tool_result" && typeof c.content === "string") parts.push(`_(tool result)_\n${c.content.slice(0, 4000)}`);
      else if (c?.type === "image") parts.push("_(image)_");
      else if (c?.type === "document") parts.push(`_(document${c.title ? `: ${c.title}` : ""})_`);
      // thinking and injected_prompt_block are not part of the conversation as the user saw it
    }
  }
  if (!parts.length && m.text) parts.push(m.text);
  for (const a of m.attachments ?? []) {
    const name = a.file_name ?? "attachment";
    const text = (a.extracted_content ?? "").trim();
    parts.push(text ? `**Attachment: ${name}**\n\n\`\`\`\n${text.slice(0, 60_000)}\n\`\`\`` : `**Attachment: ${name}** (${a.file_type ?? "file"}, content not in the export)`);
  }
  for (const f of m.files ?? []) parts.push(`**File: ${f.file_name ?? "file"}** (not included in the export)`);
  const content = parts.join("\n\n").trim();
  return content ? { role, content: content.slice(0, 400_000), createdAt: when(m.created_at) } : null;
}

function shapeConversation(c) {
  const msgs = (c.chat_messages ?? [])
    .slice()
    .sort((a, b) => when(a.created_at) - when(b.created_at))
    .map(shapeMessage)
    .filter(Boolean);
  return {
    id: String(c.uuid ?? "").replace(/[^A-Za-z0-9_.-]/g, "") || null,
    title: c.name || "Untitled",
    createdAt: when(c.created_at),
    updatedAt: when(c.updated_at ?? c.created_at),
    messages: msgs,
    projectUuid: c.project_uuid ?? c.project?.uuid ?? null,
  };
}

// ---------- talking to BitBull ----------

async function api(method, route, body, isForm = false) {
  const res = await fetch(`${GM}${route}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(isForm ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${json.error ?? json.raw ?? text.slice(0, 200)}`);
  return json;
}

(async () => {
  const ex = loadExport(inputs.map((i) => path.resolve(i)));
  const projectsIn = ex.projects.filter((p) => p?.name && (flag("include-starter") || !p.is_starter_project));
  const convsIn = ex.conversations;
  const artifactsIn = flag("no-artifacts") ? new Map() : ex.artifacts;
  const memFiles = ex.memories.flatMap((m) => m.memory_files ?? []);
  console.log(
    `Export: ${projectsIn.length} project(s)${ex.projects.length - projectsIn.length ? ` (+${ex.projects.length - projectsIn.length} starter, skipped)` : ""}, ${convsIn.length} conversation(s), ${ex.memories.length} memory file(s) with ${memFiles.length} memory document(s), ${ex.artifacts.size} artifact(s)${DRY ? " (dry run)" : ""}`,
  );
  if (!projectsIn.length && !convsIn.length && !ex.memories.length) {
    console.error("Nothing found: expected conversations.json, projects/*.json or memories/*.json in the zips/folder given.");
    process.exit(2);
  }

  /** Upload text files into a workspace ("general" or a project id), keeping relative paths, 10 per request. */
  async function uploadTexts(where, items, target) {
    let saved = 0;
    for (let i = 0; i < items.length; i += 10) {
      const form = new FormData();
      for (const it of items.slice(i, i + 10)) {
        form.append("file", new Blob([it.content]), path.posix.basename(it.rel));
        form.append("path", it.rel);
      }
      form.append("target", target);
      const r = await api("POST", `/api/projects/${where}/files`, form, true);
      saved += r.saved.length;
    }
    return saved;
  }

  const existing = DRY ? [] : (await api("GET", "/api/projects")).projects;
  const byName = new Map(existing.map((p) => [p.name.trim().toLowerCase(), p]));
  const byClaudeUuid = new Map();

  // 1. projects
  if (!flag("conversations-only")) {
    for (const p of projectsIn) {
      if (!p?.name) continue;
      const docs = (p.docs ?? []).filter((d) => d?.filename && typeof d.content === "string");
      const key = p.name.trim().toLowerCase();
      let proj = byName.get(key);
      if (DRY) {
        console.log(`  project "${p.name}": ${proj ? "exists" : "would create"}, ${docs.length} doc(s)`);
        if (p.uuid) byClaudeUuid.set(p.uuid, { id: "dry", name: p.name });
        continue;
      }
      const fields = {
        description: (p.description ?? "").slice(0, 2000) || undefined,
        instructions: (p.prompt_template ?? "").slice(0, 20000) || undefined,
      };
      if (!proj) {
        proj = (await api("POST", "/api/projects", { name: p.name.trim().slice(0, 80), ...fields })).project;
        byName.set(key, proj);
        console.log(`  created project "${proj.name}"`);
      } else {
        if (fields.description || fields.instructions) await api("PATCH", `/api/projects/${proj.id}`, fields);
        console.log(`  project "${proj.name}" exists (${proj.id}); updated description/instructions`);
      }
      if (p.uuid) byClaudeUuid.set(p.uuid, proj);
      const items = docs.map((d) => ({ rel: `docs/${String(d.filename).replace(/[\\/]+/g, "_").slice(0, 120) || "doc.md"}`, content: d.content }));
      // Claude's memory for this project: the summary plus the memory files under /projects/<uuid>/
      for (const m of ex.memories) {
        const summary = m.project_memories?.[p.uuid];
        if (summary) items.push({ rel: "memory/project-memory.md", content: `# Claude's memory of project "${p.name}"\n\n${summary}` });
      }
      for (const f of memFiles) {
        const m = new RegExp(`^/projects/${p.uuid}/(.+)$`).exec(f.path ?? "");
        if (m && typeof f.content === "string") items.push({ rel: `memory/${m[1]}`, content: f.content });
      }
      const saved = await uploadTexts(proj.id, items, "uploads/claude-import");
      if (items.length) console.log(`    ${saved} file(s) uploaded to uploads/claude-import/ (${docs.length} docs, ${items.length - docs.length} memory; ${items.length - saved} already there)`);
    }

    // account-level memory and artifacts go to the general (unfiled) workspace
    const general = [];
    for (const m of ex.memories) {
      if (m.conversations_memory) general.push({ rel: "memory/conversations-memory.md", content: `# Claude's memory from conversations\n\n${m.conversations_memory}` });
    }
    for (const f of memFiles) {
      if (typeof f.content === "string" && f.path && !f.path.startsWith("/projects/")) general.push({ rel: `memory${f.path}`, content: f.content });
    }
    const MAX_FILE = 25 * 1024 * 1024;
    const artItems = [];
    let skippedBig = 0;
    for (const [id, a] of artifactsIn) {
      if (a.meta) artItems.push({ rel: `artifacts/${id}/artifact.json`, content: JSON.stringify(a.meta, null, 2) });
      for (const f of a.files) {
        if (f.bytes > MAX_FILE) {
          skippedBig++;
          continue;
        }
        artItems.push({ rel: `artifacts/${id}/${f.rel}`, content: f.get() });
      }
    }
    if (DRY) {
      console.log(`  general workspace: would upload ${general.length} memory file(s) and ${artItems.length} artifact file(s)${skippedBig ? ` (${skippedBig} over 25 MB skipped)` : ""}`);
    } else {
      const n1 = await uploadTexts("general", general, "uploads/claude-import");
      const n2 = await uploadTexts("general", artItems, "uploads/claude-import");
      console.log(`  general workspace: ${n1}/${general.length} memory file(s), ${n2}/${artItems.length} artifact file(s) uploaded${skippedBig ? ` (${skippedBig} over 25 MB skipped)` : ""}`);
    }
  }

  // 2. conversations
  if (!flag("projects-only")) {
    const forced = one("project", "");
    let forcedId = null;
    if (forced && !DRY) {
      const p = byName.get(forced.trim().toLowerCase());
      if (!p) throw new Error(`--project "${forced}" is not a BitBull project (create it first, or let the projects import make it)`);
      forcedId = p.id;
    }
    const shaped = convsIn.map(shapeConversation).filter((c) => c.id && c.messages.length && c.updatedAt >= SINCE);
    const groups = new Map(); // projectId|null -> conversations
    let unfiled = 0;
    for (const c of shaped) {
      const pid = forcedId ?? (c.projectUuid && byClaudeUuid.get(c.projectUuid)?.id) ?? null;
      if (!pid) unfiled++;
      if (!groups.has(pid)) groups.set(pid, []);
      groups.get(pid).push(c);
    }
    console.log(`  ${shaped.length} conversation(s) with messages${SINCE ? " since " + one("since") : ""}; ${shaped.length - unfiled} filed under projects, ${unfiled} unfiled`);
    if (DRY) {
      for (const c of shaped.slice(0, 15)) console.log(`    ${new Date(c.updatedAt).toISOString().slice(0, 10)}  ${c.title} (${c.messages.length} messages)`);
      if (shaped.length > 15) console.log(`    … and ${shaped.length - 15} more`);
    } else {
      let imported = 0, skipped = 0, msgs = 0;
      for (const [pid, list] of groups) {
        for (let i = 0; i < list.length; i += 20) {
          const batch = list.slice(i, i + 20).map(({ projectUuid, ...c }) => c);
          const r = await api("POST", "/api/import/conversations", { projectId: pid, source: "claude.ai", conversations: batch });
          imported += r.imported; skipped += r.skipped; msgs += r.messages;
          process.stdout.write(`\r  imported ${imported} chat(s), ${msgs} message(s), ${skipped} already here   `);
        }
      }
      console.log();
    }
  }
  console.log(`\nDone.${DRY ? "" : " Open BitBull: imported chats are in the sidebar under their dates; a chat's next message gives the agent the whole history as context."}`);
  if (!flag("projects-only") && !flag("conversations-only")) {
    console.log(`To seed Ditto, open a project in BitBull and send: "Read uploads/claude-import/memory/ and uploads/claude-import/docs/ and save every durable fact, decision and preference to Ditto with save_memory (source bitbull, Project: <name>), merging with related memories rather than duplicating." Do the same in an unfiled chat for the account-level memory.`);
  }
})().catch((e) => {
  console.error(`\nImport failed: ${e.message}`);
  process.exit(1);
});
