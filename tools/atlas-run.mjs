#!/usr/bin/env node
/**
 * Run an exported Atlas workflow API (async: upload → execute → poll → download).
 *
 *   node atlas-run.mjs <spec.json | name> [--in key=value ...] [--file key=path ...] [--out dir] [--timeout 900]
 *   node atlas-run.mjs <spec> --inspect     # show what the spec contains (no call made)
 *   node atlas-run.mjs --list               # list specs in $ATLAS_WORKFLOWS_DIR
 *
 * Atlas embeds the base URL, version, API id and credentials in the exported JSON.
 * Field names are read defensively because the export format isn't publicly
 * specified; run --inspect on a new export and adjust PICK below if needed.
 * Docs: https://docs.atlas.design/atlas-ai-studio-overview/node-index/api-nodes
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.ATLAS_WORKFLOWS_DIR ?? "";
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const many = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
const one = (name, d) => many(name)[0] ?? d;
const die = (msg) => {
  console.error(`atlas-run: ${msg}`);
  process.exit(1);
};

if (flag("list")) {
  if (!dir || !existsSync(dir)) die("ATLAS_WORKFLOWS_DIR is not set or missing");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) console.log(f);
  process.exit(0);
}

const specArg = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!specArg) die("usage: atlas-run.mjs <spec.json|name> [--in k=v] [--file k=path] [--out dir]");
const specPath = existsSync(specArg) ? specArg : path.join(dir, specArg.endsWith(".json") ? specArg : `${specArg}.json`);
if (!existsSync(specPath)) die(`spec not found: ${specPath}`);
const spec = JSON.parse(readFileSync(specPath, "utf8"));

/** Find the first present key at any depth among candidates. */
function pick(obj, keys) {
  const stack = [obj];
  while (stack.length) {
    const o = stack.shift();
    if (!o || typeof o !== "object") continue;
    for (const k of keys) if (o[k] !== undefined && typeof o[k] !== "object") return o[k];
    stack.push(...Object.values(o).filter((v) => v && typeof v === "object"));
  }
  return undefined;
}
const PICK = {
  baseUrl: ["baseUrl", "base_url", "baseURL", "server", "host", "url"],
  version: ["version", "api_version", "apiVersion"],
  apiId: ["apiId", "api_id", "id"],
  token: ["apiKey", "api_key", "token", "access_token", "bearer", "secret", "key"],
};
const baseUrl = String(one("base", pick(spec, PICK.baseUrl) ?? "")).replace(/\/+$/, "");
const version = String(one("version", pick(spec, PICK.version) ?? "v1"));
const apiId = String(one("api-id", pick(spec, PICK.apiId) ?? ""));
const token = one("token", pick(spec, PICK.token) ?? process.env.ATLAS_API_KEY ?? "");

if (flag("inspect")) {
  const redact = (v) => (typeof v === "string" && v.length > 12 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v);
  console.log(JSON.stringify({ file: specPath, baseUrl, version, apiId, token: redact(token), topLevelKeys: Object.keys(spec) }, null, 2));
  const inputs = spec.inputs ?? spec.parameters ?? spec.input_schema ?? spec.request_schema;
  if (inputs) console.log("inputs:", JSON.stringify(inputs, null, 2).slice(0, 4000));
  process.exit(0);
}
if (!baseUrl || !apiId) die(`could not find baseUrl/apiId in ${specPath}; run with --inspect and pass --base / --api-id`);

const headers = token ? { Authorization: `Bearer ${token}`, "x-api-key": token } : {};
const inputs = Object.fromEntries(
  many("in").map((kv) => {
    const i = kv.indexOf("=");
    const k = kv.slice(0, i);
    const raw = kv.slice(i + 1);
    let v = raw;
    try {
      v = JSON.parse(raw);
    } catch {
      /* plain string */
    }
    return [k, v];
  }),
);

// 1) upload files → file_id
for (const kv of many("file")) {
  const i = kv.indexOf("=");
  const key = kv.slice(0, i);
  const file = kv.slice(i + 1);
  if (!existsSync(file)) die(`file not found: ${file}`);
  const fd = new FormData();
  fd.append("file", new Blob([readFileSync(file)]), path.basename(file));
  const r = await fetch(`${baseUrl}/${version}/upload/${apiId}`, { method: "POST", headers, body: fd });
  const body = await r.json().catch(async () => ({ raw: await r.text() }));
  if (!r.ok) die(`upload ${file} failed (${r.status}): ${JSON.stringify(body).slice(0, 400)}`);
  inputs[key] = body.file_id ?? body.id ?? body;
  console.error(`uploaded ${path.basename(file)} → ${key}=${JSON.stringify(inputs[key])}`);
}

// 2) execute (async)
const exec = await fetch(`${baseUrl}/${version}/api_execute_async/${apiId}`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(spec.wrapInputs === false ? inputs : { inputs, ...inputs }),
});
const ex = await exec.json().catch(async () => ({ raw: await exec.text() }));
if (!exec.ok) die(`execute failed (${exec.status}): ${JSON.stringify(ex).slice(0, 600)}`);
const executionId = ex.execution_id ?? ex.executionId ?? ex.id;
if (!executionId) die(`no execution_id in response: ${JSON.stringify(ex).slice(0, 400)}`);
console.error(`execution ${executionId} started`);

// 3) poll
const deadline = Date.now() + Number(one("timeout", "900")) * 1000;
let status;
for (let wait = 3000; ; wait = Math.min(wait * 1.5, 20000)) {
  await new Promise((r) => setTimeout(r, wait));
  const r = await fetch(`${baseUrl}/${version}/api_status/${executionId}`, { headers });
  status = await r.json().catch(() => ({}));
  const st = String(status.status ?? status.state ?? "").toLowerCase();
  console.error(`status: ${st || r.status}`);
  if (/(complete|success|succeeded|done|finished)/.test(st)) break;
  if (/(fail|error|cancel)/.test(st)) die(`execution failed: ${JSON.stringify(status).slice(0, 800)}`);
  if (Date.now() > deadline) die("timed out waiting for Atlas");
}

// 4) download every URL in the result
const outDir = one("out", path.join(process.cwd(), "atlas-output", String(executionId)));
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "result.json"), JSON.stringify(status, null, 2));
const urls = [...JSON.stringify(status).matchAll(/https?:\/\/[^"\s]+/g)].map((m) => m[0].replace(/\\u0026/g, "&"));
for (const [n, u] of [...new Set(urls)].entries()) {
  try {
    const r = await fetch(u);
    if (!r.ok) continue;
    const name = decodeURIComponent(new URL(u).pathname.split("/").pop() || `output-${n}`);
    writeFileSync(path.join(outDir, name), Buffer.from(await r.arrayBuffer()));
    console.log(path.join(outDir, name));
  } catch {
    /* not a downloadable asset */
  }
}
console.error(`done → ${outDir}`);
