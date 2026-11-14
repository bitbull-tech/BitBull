#!/usr/bin/env node
// Cathedral sealed sandboxes, for the agent's shell (see skills/cathedral-sandbox/SKILL.md).
//
// Every command prints exactly one JSON object on stdout and exits 0 on success, 1 on a refusal or
// an error. The spend limit, the closed network, the retries and the error shapes are enforced
// here, in code, so they can be tested; instructions alone cannot be.
//
// The key comes from CATHEDRAL_API_KEY in the environment. It is never printed, never written to
// disk and never put in an error message: everything the helper prints is passed through a
// redaction of the key as the last step. Nothing else is stored anywhere: the agent holds the
// task tag and the operation names, and the same names always send the same idempotency key.
//
// The logic is run(argv, {env, fetch, sleep}); the command line at the bottom calls it with the
// real fetch. Tests call run() with a fake fetch, so the https rule is never relaxed for them.
import { createHash, randomInt } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { effectiveCathedralCap } from "./cathedral-cap.mjs";

const MIB = 1024 * 1024;
const MAX_FILE_BYTES = 200 * MIB;
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TASK_RE = /^[a-z0-9]{1,24}$/;
const OP_RE = /^[a-z0-9]{1,32}$/;
const POLL_MS = 2000;
const POLL_LIMIT_MS = 5 * 60 * 1000;
const RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

class Refusal extends Error {
  constructor(error, message, extra = {}) {
    super(message);
    this.error = error;
    this.extra = extra;
  }
}

// ---------- small helpers ----------

const hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** Decimal string or number to whole micro-dollars, rounded up so a hold is never understated. */
function toMicros(v) {
  let s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(9) : "") : typeof v === "string" ? v.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const digits = (frac + "000000").slice(0, 6);
  const rest = frac.slice(6);
  return Number(whole) * 1e6 + Number(digits) + (/[1-9]/.test(rest) ? 1 : 0);
}
const usd = (micros) => `${Math.floor(micros / 1e6)}.${String(micros % 1e6).padStart(6, "0")}`;
/** hourly rate x seconds / 3600, rounded up to the micro-dollar */
const holdMicros = (rateMicros, seconds) => Math.floor((rateMicros * seconds + 3599) / 3600);

function intArg(v, lo, hi) {
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

/** Python's json.dumps(sort_keys=True, separators=(",", ":")), which is how a receipt's line is hashed. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${canonical(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// ---------- command line ----------

const VALUE_FLAGS = new Set(["task", "op", "size", "lifetime", "max-spend", "timeout", "cmd", "cwd", "src", "path", "out", "mode", "max-bytes", "exec"]);
const BOOL_FLAGS = new Set(["internet", "resume", "check"]);

const COMMANDS = {
  "new-task": { pos: 0, flags: [] },
  catalog: { pos: 0, flags: [] },
  account: { pos: 0, flags: [] },
  quote: { pos: 0, flags: ["size", "lifetime"] },
  create: { pos: 0, flags: ["task", "op", "size", "lifetime", "max-spend", "internet", "resume"], mutating: true },
  status: { pos: 1, flags: [] },
  exec: { pos: 1, flags: ["task", "op", "timeout", "cmd", "cwd"], mutating: true, rest: true },
  "exec-bg": { pos: 1, flags: ["task", "op", "timeout", "cmd", "cwd"], mutating: true, rest: true },
  "exec-wait": { pos: 1, flags: ["exec", "timeout"] },
  put: { pos: 1, flags: ["task", "op", "src", "path", "mode", "check"], mutating: true },
  get: { pos: 1, flags: ["path", "out", "max-bytes"] },
  receipts: { pos: 1, flags: [] },
  verify: { pos: 1, flags: [] },
  delete: { pos: 1, flags: ["task", "op"], mutating: true },
  list: { pos: 0, flags: ["task"] },
};

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const spec = COMMANDS[command];
  if (!spec) throw new Refusal("unknown_command", `Unknown command. Commands: ${Object.keys(COMMANDS).join(", ")}`);
  const flags = {};
  const pos = [];
  let rest = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      rest = tokens.slice(i + 1);
      break;
    }
    if (t.startsWith("--")) {
      const name = t.slice(2);
      if (!spec.flags.includes(name)) throw new Refusal("unknown_flag", `${command} does not take --${name}`);
      if (BOOL_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) {
        if (i + 1 >= tokens.length) throw new Refusal("missing_value", `--${name} needs a value`);
        flags[name] = tokens[++i];
      }
    } else pos.push(t);
  }
  if (rest && !spec.rest) throw new Refusal("unexpected_arguments", `${command} takes no words after --`);
  if (pos.length !== spec.pos) throw new Refusal("usage", `${command} takes ${spec.pos === 0 ? "no id" : "exactly one sandbox id"}`);
  if (pos[0] !== undefined && !SANDBOX_ID.test(pos[0])) throw new Refusal("invalid_id", "That is not a sandbox id");
  return { command, spec, flags, id: pos[0], rest };
}

/** Task and op names: a-z and 0-9 only, so bitbull-<task>-<op> can only be read one way. */
function operationKey({ flags }) {
  const { task, op } = flags;
  if (task === undefined || op === undefined) throw new Refusal("operation_names_required", "This command changes things, so it needs --task <tag> (from new-task) and --op <name>");
  if (!TASK_RE.test(task)) throw new Refusal("invalid_task", "--task may only use a-z and 0-9, at most 24 characters (use the tag new-task printed)");
  if (!OP_RE.test(op)) throw new Refusal("invalid_op", "--op may only use a-z and 0-9, at most 32 characters");
  return { task, op, key: `bitbull-${task}-${op}` };
}

// ---------- errors ----------

/** One shape for every API error. A validation item's raw input is never copied. */
function normaliseError(status, body, headers) {
  const detail = body && typeof body === "object" && !Array.isArray(body) ? body.detail : undefined;
  const top = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const obj = detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {};
  let error = `http_${status}`;
  let message = `Cathedral answered ${status}`;
  if (typeof detail === "string") {
    error = detail;
    message = detail;
  } else if (Array.isArray(detail) && detail.length) {
    const first = detail[0] && typeof detail[0] === "object" ? detail[0] : {};
    error = typeof first.type === "string" ? first.type : error;
    message = typeof first.msg === "string" ? first.msg : message;
  } else if (typeof obj.error === "string" || typeof obj.message === "string") {
    error = typeof obj.error === "string" ? obj.error : error;
    message = typeof obj.message === "string" ? obj.message : error;
  }
  // The cathedral.computer edge can answer with an empty detail and the reason
  // only in public_message: keep the generic code, but say Cathedral's sentence.
  if (message === `Cathedral answered ${status}` && typeof top.public_message === "string") message = top.public_message;
  const pick = (k) => (k in obj ? obj[k] : k in top ? top[k] : undefined);
  const headerRetry = headers?.get?.("retry-after");
  const headerSeconds = headerRetry && /^\d+$/.test(headerRetry.trim()) ? Number(headerRetry.trim()) : null;
  const field = pick("retry_after_s");
  const out = {
    ok: false,
    status,
    error,
    message,
    failed_by: pick("failed_by") ?? null,
    billed: pick("billed") ?? "unknown",
    retry_after_s: typeof field === "number" ? field : headerSeconds,
    sandbox_id: pick("sandbox_id") ?? null,
    retry_with_same_key: pick("retry_with_same_key") ?? null,
    replay_safe: pick("replay_safe") ?? null,
  };
  for (const k of ["limit", "live"]) if (k in obj) out[k] = obj[k];
  // a field that is present and null means "do not poll"; a missing field means nobody said
  out._doNotPoll = field === null && headerSeconds === null;
  return out;
}

const publicError = ({ _doNotPoll, ...rest }) => rest;

// ---------- transport ----------

function makeContext({ env, fetch, sleep }) {
  const key = env.CATHEDRAL_API_KEY;
  if (!key) throw new Refusal("no_key", "CATHEDRAL_API_KEY is not set. Ask the user to add a Cathedral key in Settings.");
  const base = (env.CATHEDRAL_API_URL || "https://cathedral.computer").replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Refusal("invalid_url", "CATHEDRAL_API_URL is not a URL");
  }
  if (url.protocol !== "https:") throw new Refusal("insecure_url", "CATHEDRAL_API_URL must be https, so the key is never sent in clear");
  return { key, base, fetch, sleep, env };
}

/**
 * One API call. Retries the identical request (same headers, same body, so the same idempotency
 * key) up to 3 times on a network error, a 5xx or a 409 exec_in_progress, unless retry is false.
 * Returns {ok:true, status, buf, json} or {ok:false, error}.
 */
async function api(ctx, method, route, { headers = {}, body, retry = true } = {}) {
  const max = retry ? RETRIES : 0;
  const init = { method, headers: { Authorization: `Bearer ${ctx.key}`, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(120000) };
  if (body !== undefined) init.body = body;
  for (let attempt = 0; ; attempt++) {
    let res;
    let buf;
    try {
      res = await ctx.fetch(`${ctx.base}${route}`, init);
      buf = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt < max) {
        await ctx.sleep(BACKOFF_MS[attempt]);
        continue;
      }
      const err = { ok: false, status: null, error: "network_error", message: `No answer from Cathedral (${e instanceof Error ? e.name : "error"}). The outcome is unknown.`, failed_by: null, billed: "unknown", retry_after_s: null, sandbox_id: null, retry_with_same_key: true, replay_safe: null };
      return { ok: false, error: err, network: true };
    }
    let json = null;
    if (buf.length) {
      try {
        json = JSON.parse(buf.toString("utf8"));
      } catch {
        json = null;
      }
    }
    if (res.ok) return { ok: true, status: res.status, buf, json, headers: res.headers };
    const full = normaliseError(res.status, json, res.headers);
    const retryable = (res.status >= 500 && full.replay_safe !== false && !full._doNotPoll) || (res.status === 409 && (full.error === "exec_in_progress" || full.error === "process_start_in_progress"));
    if (retry && retryable && attempt < max) {
      const wait = full.retry_after_s !== null ? Math.min(full.retry_after_s * 1000, 60000) : BACKOFF_MS[attempt];
      await ctx.sleep(wait);
      continue;
    }
    const err = publicError(full);
    if (err.error === "idempotency_key_reused_with_different_request") {
      err.message = "This --task and --op were already used with different arguments. Use a new --op name for a different step. (Cathedral: " + err.message + ")";
    }
    if (attempt > 0) {
      err.retry_with_same_key = true;
      err.retries = attempt;
    }
    return { ok: false, error: err, status: res.status };
  }
}

const must = (r) => {
  if (!r.ok) throw Object.assign(new Error("api"), { apiError: r.error });
  return r;
};
const failOut = (error, message, extra = {}) => ({ ok: false, status: null, error, message, failed_by: null, billed: false, retry_after_s: null, sandbox_id: null, retry_with_same_key: null, replay_safe: null, ...extra });

// ---------- account, catalog, holds ----------

async function readAccount(ctx) {
  const a = must(await api(ctx, "GET", "/v1/account")).json;
  return a && typeof a === "object" ? a : {};
}
async function readCatalog(ctx) {
  const c = must(await api(ctx, "GET", "/v1/sandboxes/catalog")).json;
  return c && typeof c === "object" ? c : {};
}
const sealedOf = (catalog) => (catalog.sealed && typeof catalog.sealed === "object" ? catalog.sealed : {});
function findSize(sealed, size) {
  const entry = (Array.isArray(sealed.sizes) ? sealed.sizes : []).find((s) => s && (s.template === size || s.name === size));
  if (!entry) throw new Refusal("unknown_size", `${size} is not one of the sealed sizes: ${(sealed.sizes ?? []).map((s) => s.template ?? s.name).join(", ") || "none listed"}`);
  const rate = toMicros(entry.hourly_rate_usd);
  if (rate === null) throw new Refusal("catalog_unreadable", `The catalog gives no usable hourly rate for ${size}`);
  return { entry, rate };
}
function parseLifetime(v) {
  const n = intArg(v, 60, 86400);
  if (n === null) throw new Refusal("invalid_lifetime", "--lifetime must be a whole number of seconds from 60 to 86400");
  return n;
}

// ---------- receipts ----------

async function fetchChain(ctx, id) {
  let after = 0;
  let count = 0;
  let last = null;
  for (let stalls = 0, pages = 0; pages < 200; pages++) {
    const body = must(await api(ctx, "GET", `/v1/sandboxes/${id}/receipts?after=${after}&limit=500`)).json ?? {};
    const list = Array.isArray(body.receipts) ? body.receipts : [];
    count += list.length;
    if (list.length) last = list[list.length - 1];
    const next = body.next_after ?? null;
    if (next === null) break;
    // an empty page that reports a newer head repeats the cursor: ask again, a few times
    if (!list.length && next === after && ++stalls > 3) throw new Refusal("receipts_stalled", "The receipt list stopped advancing");
    after = next;
  }
  return { count, head_n: last && typeof last.n === "number" ? last.n : null, head_sha256: last ? hex(canonical(last)) : null };
}

const hasFailedCheck = (r) => !!r && (r.signature_verified === false || Object.values(r.checks ?? {}).some((v) => v === "failed"));

async function verifyAll(ctx, id) {
  let after = 0;
  let roomOffset = 0;
  let chainDone = false;
  let roomDone = false;
  const failures = [];
  let pages = 0;
  let checked = 0;
  let incomplete = false;
  let roomCount = 0;
  let roomVerified = 0;
  let roomFailed = 0;
  let createCheck = null;
  let sawChain = false;
  for (; pages < 50; ) {
    const body = must(await api(ctx, "GET", `/v1/sandboxes/${id}/receipts/verify?after=${after}&room_offset=${roomOffset}`)).json ?? {};
    pages++;
    const first = pages === 1;
    if (!chainDone) {
      const chain = body.chain;
      if (!chain || typeof chain !== "object") throw new Refusal("verify_unreadable", "Cathedral's verify answer has no chain block");
      sawChain = true;
      for (const f of Array.isArray(chain.failures) ? chain.failures : []) failures.push({ n: f.n ?? null, check: f.check ?? null, reason: typeof f.reason === "string" ? f.reason : null });
      if (chain.passed === false && !(chain.failures ?? []).length) failures.push({ n: null, check: "range", reason: "the range did not pass" });
      if (typeof chain.from_n === "number" && typeof chain.to_n === "number") checked += chain.to_n - chain.from_n + 1;
      const next = chain.next_after ?? null;
      // verified is true only when one answer covered the whole chain; a page of a longer chain says false
      if (first && next === null && chain.verified !== true) incomplete = true;
      if (next === null) chainDone = true;
      else after = next;
    }
    if (!roomDone) {
      const room = body.room_receipts;
      if (first && hasFailedCheck(body.room_receipt)) roomFailed++;
      if (first && body.room_receipt?.checks) createCheck = body.room_receipt.checks;
      if (room && typeof room === "object") {
        for (const r of Array.isArray(room.receipts) ? room.receipts : []) {
          roomCount++;
          if (r.signature_verified === true) roomVerified++;
          if (hasFailedCheck(r)) roomFailed++;
        }
        const next = room.next_offset ?? null;
        if (next === null) roomDone = true;
        else roomOffset = next;
      } else roomDone = true;
    }
    if (chainDone && roomDone) break;
  }
  const ok = sawChain && !failures.length && !incomplete && roomFailed === 0 && chainDone && roomDone;
  return {
    ok,
    chain: { pages, receipts_checked: checked, failures, complete_in_one_answer: undefined },
    room: { receipts: roomCount, signature_verified: roomVerified, failed: roomFailed, create_checks: createCheck },
    checked: [
      "each Cathedral receipt's schema and Ed25519 signature, as Cathedral checks them itself (a check by the signer, not independent)",
      "receipt numbers gapless and each receipt linked to the one before it",
      "each room receipt's digest, room name, binding hash and signature, where Cathedral could check them",
    ],
    not_checked: [
      "the AMD SEV-SNP report and AMD's certificate chain (needs the offline verifier)",
      "the approved build measurement (compare with https://cathedral.computer/approved-measurements.json)",
      "room receipt completeness: the guest does not sign file transfers or lifetime changes, and gaps in the host's sequence are not checked",
      "that no receipts were cut from the end of the chain",
    ],
    note: incomplete ? "the chain was not reported verified in one answer" : undefined,
  };
}

// ---------- commands ----------

async function cmdCatalog(ctx) {
  const s = sealedOf(await readCatalog(ctx));
  return {
    ok: true,
    sealed: {
      available: s.available === true,
      reason: s.reason ?? null,
      network_modes: Array.isArray(s.network_modes) ? s.network_modes : null,
      sizes: (Array.isArray(s.sizes) ? s.sizes : []).map((z) => ({ template: z.template ?? z.name ?? null, resources: z.resources ?? null, hourly_rate_usd: z.hourly_rate_usd ?? null })),
      remaining: s.remaining ?? null,
    },
  };
}

async function cmdAccount(ctx) {
  const a = await readAccount(ctx);
  return {
    ok: true,
    scopes: a.scopes ?? null,
    api_key: a.api_key ?? null,
    effective_cap_usd: usd(Math.round(effectiveCathedralCap(ctx.env.CATHEDRAL_MAX_SPEND_USD) * 1e6)),
    uncapped_allowed: ctx.env.CATHEDRAL_ALLOW_UNCAPPED_KEY === "on",
  };
}

async function cmdQuote(ctx, { flags }) {
  if (!flags.size) throw new Refusal("size_required", "--size is required");
  const lifetime = parseLifetime(flags.lifetime);
  const { rate } = findSize(sealedOf(await readCatalog(ctx)), flags.size);
  return { ok: true, size: flags.size, lifetime_seconds: lifetime, hourly_rate_usd: usd(rate), hold_usd: usd(holdMicros(rate, lifetime)), note: "pass hold_usd (or more, up to your spend limit) as --max-spend to create" };
}

async function cmdCreate(ctx, parsed) {
  const { flags } = parsed;
  const { task, op, key } = operationKey(parsed);
  const resume = flags.resume === true;
  if (!flags.size) throw new Refusal("size_required", "--size is required");
  const lifetime = parseLifetime(flags.lifetime);
  const spend = flags["max-spend"] === undefined ? null : toMicros(flags["max-spend"]);
  if (spend === null || spend <= 0) throw new Refusal("invalid_max_spend", "--max-spend must be a positive amount in USD (run quote first and pass its hold_usd)");
  // never skipped, and needs no live balance: the amount is held to the effective cap
  const capMicros = Math.round(effectiveCathedralCap(ctx.env.CATHEDRAL_MAX_SPEND_USD) * 1e6);
  if (spend > capMicros) throw new Refusal("max_spend_above_cap", `--max-spend ${usd(spend)} is above the spend cap of ${usd(capMicros)} (Settings, Cathedral)`);

  const account = await readAccount(ctx);
  const block = account.api_key;
  if (!block || typeof block !== "object" || Array.isArray(block) || !("budget_usd" in block)) {
    throw new Refusal("account_unreadable", "Cathedral's account answer has no readable api_key block, so the key's cap is unknown. Nothing was created.");
  }
  if (Array.isArray(account.scopes) && !account.scopes.includes("sandboxes:control")) throw new Refusal("missing_scope", "This key cannot create sandboxes: it lacks the sandboxes:control scope");
  let limit = capMicros;
  let remaining = null;
  if (block.budget_usd === null) {
    if (ctx.env.CATHEDRAL_ALLOW_UNCAPPED_KEY !== "on") throw new Refusal("uncapped_key_refused", "This key has no spending cap of its own, so the helper will not create sandboxes with it. Use a capped key, or the user can turn on Allow a key with no spending cap in Settings.");
  } else {
    remaining = toMicros(block.remaining_usd);
    if (remaining === null) throw new Refusal("account_unreadable", "Cathedral's account answer has a cap but no readable remaining amount. Nothing was created.");
    limit = Math.min(capMicros, remaining);
  }

  const sealed = sealedOf(await readCatalog(ctx));
  if (sealed.available !== true && !resume) throw new Refusal("sealed_unavailable", `Sealed sandboxes are unavailable: ${sealed.reason ?? "no reason given"}`);
  const { rate } = findSize(sealed, flags.size);
  const wanted = flags.internet === true ? "internet" : "deny_all";
  const modes = Array.isArray(sealed.network_modes) ? sealed.network_modes : [];
  // never falls back to a more open mode
  if (!modes.includes(wanted)) throw new Refusal("network_mode_not_offered", `The catalog does not offer network mode ${wanted} for sealed sandboxes (offered: ${modes.join(", ") || "none listed"}). Nothing was created.`);

  if (!resume) {
    if (remaining !== null && spend > remaining) throw new Refusal("max_spend_above_remaining", `--max-spend ${usd(spend)} is above what the key has left (${usd(remaining)})`);
    const hold = holdMicros(rate, lifetime);
    if (hold > spend) throw new Refusal("hold_exceeds_max_spend", `The hold at today's rate is ${usd(hold)}, above --max-spend ${usd(spend)}. Run quote again.`);
    if (hold > limit) throw new Refusal("hold_exceeds_limit", `The hold ${usd(hold)} is above the spend limit ${usd(limit)}`);
  }

  const body = {
    required_hardware: "amd_sev_snp",
    template: flags.size,
    network: wanted,
    lifetime_seconds: lifetime,
    max_spend_usd: usd(spend),
    labels: { bitbull: "1", bitbull_task: task },
  };
  const r = await api(ctx, "POST", "/v1/sandboxes", { headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return r.error;
  let sb = r.json ?? {};
  const id = sb.id;
  let waited = 0;
  while (sb.state === "creating" && id) {
    const s = await api(ctx, "GET", `/v1/sandboxes/${id}`);
    if (!s.ok) return s.error;
    sb = s.json ?? {};
    if (sb.state !== "creating") break;
    if (waited >= POLL_LIMIT_MS) return failOut("create_not_ready", "The sandbox is still being created after 5 minutes. Run the same create again later with --resume.", { sandbox_id: id, retry_with_same_key: true });
    await ctx.sleep(POLL_MS);
    waited += POLL_MS;
  }
  if (sb.state !== "running") {
    return failOut(sb.error_code ?? sb.error?.code ?? `sandbox_${sb.state ?? "unknown"}`, sb.error?.message ?? `The sandbox ended in state ${sb.state ?? "unknown"}`, {
      failed_by: sb.failed_by ?? null,
      billed: sb.billed ?? "unknown",
      sandbox_id: id ?? null,
    });
  }
  return {
    ok: true,
    sandbox_id: id,
    state: "running",
    size: flags.size,
    network: wanted,
    lifetime_seconds: lifetime,
    max_spend_usd: usd(spend),
    spend_limit_usd: usd(limit),
    labels: body.labels,
    receipt_id: sb.receipt_id ?? null,
    hotel: sb.hotel ?? null,
    lifetime_deadline_at: sb.lifetime_deadline_at ?? null,
    task,
    op,
  };
}

async function cmdStatus(ctx, { id }) {
  const s = must(await api(ctx, "GET", `/v1/sandboxes/${id}`)).json ?? {};
  const pick = {};
  for (const k of ["id", "state", "template", "resources", "network", "labels", "failed_by", "billed", "lifetime_deadline_at", "cleanup_state", "max_spend_usd", "receipts", "error", "hotel", "sealed"]) if (k in s) pick[k] = s[k];
  return { ok: true, ...pick };
}

function commandBody(parsed, timeout) {
  const { flags, rest } = parsed;
  if (flags.cmd !== undefined && rest && rest.length) throw new Refusal("usage", "Give the command as --cmd '<shell string>' or as words after --, not both");
  let command;
  if (flags.cmd !== undefined) command = flags.cmd;
  else if (rest && rest.length) command = rest;
  else throw new Refusal("command_required", "Give a command: --cmd '<shell string>' or words after --");
  const body = { command, timeout_seconds: timeout };
  if (flags.cwd !== undefined) body.cwd = flags.cwd;
  return body;
}

async function cmdExec(ctx, parsed) {
  const { key } = operationKey(parsed);
  const timeout = parsed.flags.timeout === undefined ? 45 : intArg(parsed.flags.timeout, 1, 45);
  if (timeout === null) throw new Refusal("invalid_timeout", "--timeout for exec must be 1 to 45 seconds; use exec-bg for longer");
  const body = commandBody(parsed, timeout);
  const r = await api(ctx, "POST", `/v1/sandboxes/${parsed.id}/exec`, { headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return r.error;
  const x = r.json ?? {};
  const timedOut = x.timed_out === true;
  const ok = x.exit_code === 0 && !timedOut;
  const out = {
    ok,
    exit_code: x.exit_code ?? null,
    stdout: x.stdout ?? "",
    stderr: x.stderr ?? "",
    timed_out: timedOut,
    duration_ms: x.duration_ms ?? null,
    stdout_truncated: x.stdout_truncated ?? false,
    stderr_truncated: x.stderr_truncated ?? false,
    room_receipt_id: x.room_receipt_id ?? null,
  };
  if (x.room_alive === false) out.room_alive = false;
  if (x.oom_killed === true) out.oom_killed = true;
  if (!ok) {
    out.error = timedOut ? "exec_timed_out" : "command_failed";
    out.message = timedOut ? "The command hit its deadline" : `The command exited with ${x.exit_code}`;
  }
  return out;
}

async function cmdExecBg(ctx, parsed) {
  const { key } = operationKey(parsed);
  const timeout = intArg(parsed.flags.timeout, 1, 1800);
  if (timeout === null) throw new Refusal("invalid_timeout", "exec-bg needs an explicit --timeout from 1 to 1800 seconds");
  const body = commandBody(parsed, timeout);
  const r = await api(ctx, "POST", `/v1/sandboxes/${parsed.id}/execs`, { headers: { "Idempotency-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) return r.error;
  const x = r.json ?? {};
  return { ok: true, exec_id: x.exec_id ?? null, state: x.state ?? "running", timeout_seconds: timeout };
}

async function cmdExecWait(ctx, { id, flags }) {
  if (!flags.exec || !SANDBOX_ID.test(flags.exec)) throw new Refusal("exec_required", "--exec <exec_id> is required");
  const timeout = flags.timeout === undefined ? 1800 : intArg(flags.timeout, 1, 14400);
  if (timeout === null) throw new Refusal("invalid_timeout", "--timeout must be 1 to 14400 seconds");
  const polls = Math.ceil((timeout + 60) / 25) + 1;
  let x = {};
  for (let i = 0; i < polls; i++) {
    const r = await api(ctx, "GET", `/v1/sandboxes/${id}/execs/${flags.exec}?wait=25`);
    if (!r.ok) return r.error;
    x = r.json ?? {};
    if (x.state !== "running") break;
    if (typeof x.poll_after_s === "number") await ctx.sleep(x.poll_after_s * 1000);
  }
  const base = { exec_id: flags.exec, state: x.state ?? "unknown", exit_code: x.exit_code ?? null, stdout: x.stdout ?? "", stderr: x.stderr ?? "", duration_ms: x.duration_ms ?? null };
  switch (x.state) {
    case "exited":
      return x.exit_code === 0 ? { ok: true, ...base } : { ok: false, ...base, error: "command_failed", message: `The command exited with ${x.exit_code}` };
    case "timed_out":
      return { ok: false, ...base, error: "exec_timed_out", message: "The command hit its deadline" };
    case "killed":
      return { ok: false, ...base, error: "exec_killed", message: "The command was killed" };
    case "lost":
      return { ok: false, ...base, outcome: "unknown", error: "exec_lost", message: `Outcome unknown: Cathedral lost the command's result${x.message ? ` (${x.message})` : ""}. It may or may not have run.`, failed_by: x.failed_by ?? null, billed: x.billed ?? "unknown" };
    case "running":
      return { ok: false, ...base, error: "still_running", message: "The command is still running. Run exec-wait again.", retry_with_same_key: null };
    default:
      return { ok: false, ...base, error: "unexpected_state", message: `Unexpected exec state ${x.state}` };
  }
}

/** A sealed room's files API reaches /work only (Cathedral answers 422 otherwise). */
function workPath(path) {
  const parts = path.split("/");
  if (!path.startsWith("/work/") || path.length > 2048 || path.includes("\u0000") || parts.some((x) => x === ".." || x === ".")) {
    throw new Refusal("path_outside_work", "Sealed sandboxes move files under /work only. Use a path like /work/notes.txt");
  }
  return path;
}

async function cmdPut(ctx, parsed) {
  const { flags, id } = parsed;
  const { key } = operationKey(parsed);
  if (!flags.src || !flags.path) throw new Refusal("usage", "put needs --src <local file> and --path <path in the sandbox>");
  workPath(flags.path);
  const mode = flags.mode === undefined ? 420 : intArg(flags.mode, 0, 4095);
  if (mode === null) throw new Refusal("invalid_mode", "--mode is a decimal file mode such as 420 (octal 644)");
  let size;
  try {
    size = statSync(flags.src).size;
  } catch {
    throw new Refusal("src_unreadable", "Cannot read the --src file");
  }
  if (size > MAX_FILE_BYTES) throw new Refusal("file_too_large", "The file is over 200 MiB, the limit for one upload. Nothing was sent.");
  const bytes = readFileSync(flags.src);
  const sha = hex(bytes);
  const r = await api(ctx, "PUT", `/v1/sandboxes/${id}/files?path=${encodeURIComponent(flags.path)}&mode=${mode}`, {
    headers: { "Idempotency-Key": `${key}-${sha.slice(0, 12)}`, "Content-Type": "application/octet-stream" },
    body: bytes,
    retry: false,
  });
  if (r.ok) return { ok: true, path: flags.path, bytes: bytes.length, sha256: sha };
  // an answer that is not a plain refusal (the connection dropped, or a 5xx) leaves the upload's fate unknown
  if (r.network || (r.status ?? 0) >= 500) {
    const unknown = failOut("upload_outcome_unknown", "Upload outcome unknown: the answer was lost, and the file may or may not have landed.", {
      status: r.status ?? null,
      sandbox_id: id,
      billed: "unknown",
      sha256: sha,
    });
    if (!flags.check) return { ...unknown, hint: "Run put again with --check to read the path back, or decide with the user before sending again under a new --op." };
    const back = await api(ctx, "GET", `/v1/sandboxes/${id}/files?path=${encodeURIComponent(flags.path)}&max_bytes=${MAX_FILE_BYTES}`);
    if (back.ok) {
      const seen = hex(back.buf);
      if (seen === sha) return { ok: true, landed: true, path: flags.path, bytes: bytes.length, sha256: sha };
      return { ...unknown, observed: { sha256: seen, bytes: back.buf.length }, hint: "The path holds different bytes now. The upload may have landed and been changed since by another step. Ask the user before uploading again." };
    }
    if (back.status === 404) return { ...unknown, observed: { absent: true }, hint: "The path is absent now. The upload may have landed and been removed since. Ask the user before uploading again." };
    return { ...unknown, observed: { unreadable: true }, hint: "The path could not be read back. Ask the user before uploading again." };
  }
  return r.error;
}

async function cmdGet(ctx, { id, flags }) {
  if (!flags.path || !flags.out) throw new Refusal("usage", "get needs --path <path in the sandbox> and --out <local file>");
  workPath(flags.path);
  const max = flags["max-bytes"] === undefined ? MAX_FILE_BYTES : intArg(flags["max-bytes"], 1, MAX_FILE_BYTES);
  if (max === null) throw new Refusal("invalid_max_bytes", "--max-bytes must be 1 to 209715200 (200 MiB)");
  const r = await api(ctx, "GET", `/v1/sandboxes/${id}/files?path=${encodeURIComponent(flags.path)}&max_bytes=${max}`);
  if (!r.ok) return r.error;
  writeFileSync(flags.out, r.buf);
  return { ok: true, path: flags.path, out: flags.out, bytes: r.buf.length, sha256: hex(r.buf) };
}

async function cmdDelete(ctx, parsed) {
  const { id } = parsed;
  const { key } = operationKey(parsed);
  const d = await api(ctx, "DELETE", `/v1/sandboxes/${id}`, { headers: { "Idempotency-Key": key } });
  if (!d.ok) return d.error;
  let state = d.json?.state;
  let waited = 0;
  while (state !== "deleted") {
    const s = await api(ctx, "GET", `/v1/sandboxes/${id}`);
    if (!s.ok) return s.error;
    state = s.json?.state;
    if (state === "deleted") break;
    if (state !== "deleting") return failOut("delete_unexpected_state", `The sandbox is in state ${state} after delete`, { sandbox_id: id });
    if (waited >= POLL_LIMIT_MS) return failOut("not_yet_deleted", `Sandbox ${id} is not yet deleted after 5 minutes. Check it later with status ${id}.`, { sandbox_id: id });
    await ctx.sleep(POLL_MS);
    waited += POLL_MS;
  }
  // fetched again after the delete, so the head includes the delete receipt
  try {
    return { ok: true, sandbox_id: id, state: "deleted", receipts: await fetchChain(ctx, id) };
  } catch (e) {
    return { ok: true, sandbox_id: id, state: "deleted", receipts_error: e.apiError?.error ?? e.error ?? "receipts_unreadable" };
  }
}

async function cmdList(ctx, { flags }) {
  if (flags.task !== undefined && !TASK_RE.test(flags.task)) throw new Refusal("invalid_task", "--task may only use a-z and 0-9, at most 24 characters");
  const labels = ["bitbull=1", ...(flags.task ? [`bitbull_task=${flags.task}`] : [])];
  const all = [];
  for (let offset = 0, page = 0; page < 20; page++) {
    const q = [`limit=50`, `offset=${offset}`, ...labels.map((l) => `label=${encodeURIComponent(l)}`)].join("&");
    const body = must(await api(ctx, "GET", `/v1/sandboxes?${q}`)).json;
    const items = Array.isArray(body) ? body : Array.isArray(body?.sandboxes) ? body.sandboxes : Array.isArray(body?.items) ? body.items : [];
    all.push(...items);
    if (!body?.has_more || !items.length) break;
    offset += items.length;
  }
  return {
    ok: true,
    sandboxes: all.map((s) => ({ id: s.id, state: s.state, template: s.template ?? null, labels: s.labels ?? {}, lifetime_deadline_at: s.lifetime_deadline_at ?? null })),
  };
}

// ---------- entry ----------

const HANDLERS = {
  catalog: cmdCatalog,
  account: cmdAccount,
  quote: cmdQuote,
  create: cmdCreate,
  status: cmdStatus,
  exec: cmdExec,
  "exec-bg": cmdExecBg,
  "exec-wait": cmdExecWait,
  put: cmdPut,
  get: cmdGet,
  receipts: async (ctx, { id }) => ({ ok: true, ...(await fetchChain(ctx, id)) }),
  verify: async (ctx, { id }) => verifyAll(ctx, id),
  delete: cmdDelete,
  list: cmdList,
};

/**
 * Run one command. Never throws, never writes to stderr: the answer is {code, out, stdout, stderr}
 * where stdout is the one JSON line to print.
 */
export async function run(argv, { env, fetch, sleep }) {
  const key = env.CATHEDRAL_API_KEY;
  let out;
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "new-task") {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      out = { ok: true, task: "t" + Array.from({ length: 12 }, () => chars[randomInt(chars.length)]).join("") };
    } else {
      const ctx = makeContext({ env, fetch, sleep });
      out = await HANDLERS[parsed.command](ctx, parsed);
    }
  } catch (e) {
    if (e instanceof Refusal) out = failOut(e.error, e.message, e.extra);
    else if (e && e.apiError) out = e.apiError;
    else out = failOut("helper_error", `The helper hit an unexpected error (${e instanceof Error ? e.name : "error"})`);
  }
  let text = JSON.stringify(out);
  // last step, whatever happened above: the key is in nothing the helper prints
  if (key && key.length >= 8) text = text.split(key).join("[REDACTED]");
  const printed = JSON.parse(text);
  return { code: printed.ok === true ? 0 : 1, out: printed, stdout: `${text}\n`, stderr: "" };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await run(process.argv.slice(2), { env: process.env, fetch: globalThis.fetch, sleep: realSleep });
  process.stdout.write(r.stdout);
  process.exitCode = r.code;
}
