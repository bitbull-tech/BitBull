#!/usr/bin/env node
/**
 * Bring a Claude.ai account export into BitBob: every project (name, instructions, docs) and
 * every conversation (as chats, with their original dates).
 *
 *   node tools/import-claude-export.mjs <export .zip or extracted folder>
 *        [--gm http://localhost:8787] [--token <APP_TOKEN>]
 *        [--projects-only | --conversations-only] [--project "<name>"] [--since 2026-01-01]
 *        [--dry-run]
 *
 * Get the export from claude.ai: Settings → Privacy → Export data. Anthropic emails a zip with
 * conversations.json, projects.json and users.json. Point this script at the zip (or the
 * folder you extracted it to). Safe to re-run: projects are matched by name, conversations by
 * their Claude id, so nothing is imported twice.
 *
 * Where things go:
 *   projects.json → BitBob projects (description + instructions), docs uploaded to
 *                   uploads/claude-import/docs/ in each project's workspace
 *   conversations.json → chats, filed under their project when the export says which
 *                   (project_uuid), or under --project "<name>" if given, else unfiled.
 *                   Attachments' extracted text is kept with the message; images are named only.
 *
 * The token is read from --token, GM_APP_TOKEN, or APP_TOKEN in the repo's .env (never printed).
 * Nothing is sent anywhere except the BitBob URL. Needs Node 20+.
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
const input = args.find((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1] ?? ""));
if (!input || flag("help")) {
  console.log("usage: node tools/import-claude-export.mjs <export.zip | folder> [--gm url] [--token t] [--projects-only|--conversations-only] [--project name] [--since YYYY-MM-DD] [--dry-run]");
  process.exit(input ? 0 : 2);
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

function loadExport(src) {
  const want = ["conversations.json", "projects.json"];
  const found = {};
  if (statSync(src).isDirectory()) {
    const walk = (dir, depth) => {
      for (const n of readdirSync(dir)) {
        const f = path.join(dir, n);
        if (statSync(f).isDirectory()) {
          if (depth < 3) walk(f, depth + 1);
        } else if (want.includes(n) && !found[n]) found[n] = () => readFileSync(f);
      }
    };
    walk(src, 0);
  } else {
    for (const [name, get] of readZip(src)) {
      const base = path.posix.basename(name);
      if (want.includes(base) && !found[base]) found[base] = get;
    }
  }
  const parse = (n) => (found[n] ? JSON.parse(found[n]().toString("utf8")) : null);
  return { projects: parse("projects.json"), conversations: parse("conversations.json") };
}

// ---------- shaping ----------

const when = (s) => {
  const t = Date.parse(s ?? "");
  return Number.isFinite(t) ? t : Date.now();
};

/** One Claude message → BitBob {role, content}. Text parts joined; attachments' text kept. */
function shapeMessage(m) {
  const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
  if (!role) return null;
  const parts = [];
  if (Array.isArray(m.content) && m.content.length) {
    for (const c of m.content) {
      if (c?.type === "text" && c.text) parts.push(c.text);
      else if (c?.type === "tool_use" && c.name) parts.push(`_(used tool ${c.name})_`);
      else if (c?.type === "tool_result" && typeof c.content === "string") parts.push(`_(tool result)_\n${c.content.slice(0, 4000)}`);
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

// ---------- talking to BitBob ----------

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
  const ex = loadExport(path.resolve(input));
  const projectsIn = Array.isArray(ex.projects) ? ex.projects : [];
  const convsIn = Array.isArray(ex.conversations) ? ex.conversations : [];
  console.log(`Export: ${projectsIn.length} project(s), ${convsIn.length} conversation(s)${DRY ? " (dry run)" : ""}`);
  if (!projectsIn.length && !convsIn.length) {
    console.error("Nothing found: expected conversations.json and/or projects.json in the zip or folder.");
    process.exit(2);
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
      let saved = 0;
      for (let i = 0; i < docs.length; i += 10) {
        const form = new FormData();
        for (const d of docs.slice(i, i + 10)) {
          const name = String(d.filename).replace(/[\\/]+/g, "_").slice(0, 120) || "doc.md";
          form.append("file", new Blob([d.content]), name);
          form.append("path", `docs/${name}`);
        }
        form.append("target", "uploads/claude-import");
        const r = await api("POST", `/api/projects/${proj.id}/files`, form, true);
        saved += r.saved.length;
      }
      if (docs.length) console.log(`    ${saved} doc(s) uploaded to uploads/claude-import/docs/ (${docs.length - saved} already there)`);
    }
  }

  // 2. conversations
  if (!flag("projects-only")) {
    const forced = one("project", "");
    let forcedId = null;
    if (forced && !DRY) {
      const p = byName.get(forced.trim().toLowerCase());
      if (!p) throw new Error(`--project "${forced}" is not a BitBob project (create it first, or let the projects import make it)`);
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
  console.log(`\nDone.${DRY ? "" : " Open BitBob: imported chats are in the sidebar under their dates; a chat's next message gives the agent the whole history as context."}`);
  if (!flag("projects-only") && !flag("conversations-only")) {
    console.log(`To seed Ditto from a project's docs, open it in BitBob and send: "Read uploads/claude-import/docs/ and save the durable facts and decisions to Ditto with save_memory (source bitbob), merging with related memories."`);
  }
})().catch((e) => {
  console.error(`\nImport failed: ${e.message}`);
  process.exit(1);
});
