/**
 * Telegram is private to one account: these tests run the real polling loop against a stand-in
 * Bot API and check that only the paired account's private chat is ever answered, that pairing
 * can't be guessed or planted, and that the token never shows up where it shouldn't.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Made up, and put together at run time so no scanner mistakes a test value for a real bot token.
const fakeToken = (id: string, fill: string) => [id, fill.repeat(36)].join(":");
const TOKEN = fakeToken("123456789", "t");

// ---------- a stand-in api.telegram.org ----------
interface Sent {
  method: string;
  chat_id?: number;
  text?: string;
}
const sent: Sent[] = [];
let queue: unknown[] = [];
let nextUpdate = 100;
let conflict = false;
const seenTokens = new Set<string>();

const api = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!m) return reply(404, { ok: false, error_code: 404, description: "Not Found" });
    const [, tok, method] = m;
    seenTokens.add(tok);
    if (tok !== TOKEN) return reply(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const body = raw ? JSON.parse(raw) : {};
    if (method === "getMe") return reply(200, { ok: true, result: { id: 42, is_bot: true, first_name: "My BitBull", username: "my_bitbull_bot" } });
    if (method === "getUpdates") {
      if (conflict) return reply(409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" });
      const out = queue.filter((u) => (u as { update_id: number }).update_id >= (body.offset ?? 0));
      queue = [];
      // a short "long poll" so the loop spins quickly in tests
      return setTimeout(() => reply(200, { ok: true, result: out }), out.length ? 0 : 30);
    }
    sent.push({ method, chat_id: body.chat_id, text: body.text });
    return reply(200, { ok: true, result: { message_id: sent.length } });
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));

// Must be set before config/db are imported: they read the environment at module load.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bitbull-telegram-"));
process.env.APP_TOKEN = "test-token";
process.env.DITTO_ARCHIVE = "off";
process.env.DITTO_API_KEY = "";
process.env.SQLITE_JOURNAL = "DELETE";
process.env.TELEGRAM_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
process.env.TELEGRAM_BOT_TOKEN = TOKEN;
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";

const { config, reloadConfig } = await import("./config.js");
const { db, sessions } = await import("./db.js");
const { engines } = await import("./agent.js");
const { recent, redact } = await import("./activity.js");
const { builtIn } = await import("./egress.js");
const { schedules, runSchedule } = await import("./schedules.js");
const tg = await import("./telegram.js");
type AgentEvent = import("./engines/types.js").AgentEvent;

after(() => {
  tg._stopTelegram();
  api.close();
});

const OWNER = 7001;
const STRANGER = 6660;
const now = () => Math.floor(Date.now() / 1000);
const msg = (from: number, text: string | undefined, extra: Record<string, unknown> = {}) => ({
  update_id: nextUpdate++,
  message: { message_id: nextUpdate, date: now(), text, from: { id: from, first_name: from === OWNER ? "Tom" : "Mallory" }, chat: { id: from, type: "private" }, ...extra },
});
const push = (...u: unknown[]) => queue.push(...u);
const texts = (chat = OWNER) => sent.filter((s) => s.method === "sendMessage" && s.chat_id === chat).map((s) => s.text ?? "");

async function until(cond: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
/** Let the loop take everything queued, then one more empty poll. */
async function drained() {
  await until(() => queue.length === 0, "queue taken");
  await new Promise((r) => setTimeout(r, 120));
}

let prompts: string[] = [];
function fakeEngine(reply: string | (() => AgentEvent[]), gate?: Promise<void>) {
  engines.opencode = {
    id: "opencode",
    label: "Fake",
    async *run(input: { prompt: string }) {
      prompts.push(input.prompt);
      if (gate) await gate;
      const evs = typeof reply === "string" ? ([{ type: "text", delta: reply }, { type: "done", engineSessionId: "e" }] as AgentEvent[]) : reply();
      for (const ev of evs) yield ev;
    },
  } as unknown as (typeof engines)["opencode"];
}

test("long replies are split under Telegram's limit, at a paragraph where there is one", () => {
  assert.deepEqual(tg.splitMessage("short"), ["short"]);
  const para = "word ".repeat(300).trim(); // 1499 chars
  const parts = tg.splitMessage([para, para, para, para].join("\n\n"));
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= tg.CHUNK, `part of ${p.length}`);
  assert.equal(parts.join("\n\n"), [para, para, para, para].join("\n\n"), "nothing lost, cut between paragraphs");
  // no break to find: cut hard, and never through an emoji
  const solid = tg.splitMessage("x".repeat(99) + "😀".repeat(10), 100);
  assert.equal(solid.join(""), "x".repeat(99) + "😀".repeat(10));
  for (const p of solid) assert.ok(!/^[\uDC00-\uDFFF]/.test(p) && !/[\uD800-\uDBFF]$/.test(p));
});

test("it connects with the token, and says nothing to anyone before pairing", async () => {
  tg.syncTelegram();
  await until(() => tg.telegramState().status === "on", "connected");
  const s = tg.telegramState();
  assert.equal(s.bot?.username, "my_bitbull_bot");
  assert.equal(s.paired, null);
  assert.equal(s.pairing, null);
  assert.ok(!JSON.stringify(s).includes(TOKEN), "state never carries the token");

  fakeEngine("should never run");
  push(msg(STRANGER, "hello?"), msg(OWNER, "/start"), msg(OWNER, "do something"));
  await drained();
  assert.equal(sent.filter((x) => x.method === "sendMessage").length, 0, "nobody is answered before pairing");
  assert.equal(prompts.length, 0);
  assert.equal(tg.telegramState().ignored, 3);
});

test("pairing: a wrong code is ignored in silence, the right one pairs that account only", async () => {
  const p = tg.startPairing().pairing!;
  assert.match(p.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(p.link, `https://t.me/my_bitbull_bot?start=${p.code}`);

  push(msg(STRANGER, "/start WRONGCOD"), msg(STRANGER, "AAAAAAAA"));
  await drained();
  assert.equal(texts(STRANGER).length, 0, "a stranger guessing gets no reply");
  assert.equal(tg.owner(), null);

  // groups never pair, even with the right code
  push({ update_id: nextUpdate++, message: { message_id: 1, date: now(), text: `/start ${p.code}`, from: { id: OWNER }, chat: { id: -500, type: "group" } } });
  await drained();
  assert.equal(tg.owner(), null);
  assert.equal(sent.filter((s) => s.chat_id === -500).length, 0);

  push(msg(OWNER, `/start ${p.code.toLowerCase()}`)); // what the t.me link sends; case doesn't matter
  await until(() => !!tg.owner(), "paired");
  assert.equal(tg.owner()!.id, OWNER);
  assert.equal(tg.owner()!.name, "Tom");
  await until(() => texts().length === 1, "pairing confirmation");
  assert.match(texts()[0], /^Paired\./);
  assert.equal(tg.telegramState().pairing, null, "the code is used up");

  // the same code again, from someone else: no longer a code
  push(msg(STRANGER, `/start ${p.code}`));
  await drained();
  assert.equal(tg.owner()!.id, OWNER);
  assert.equal(texts(STRANGER).length, 0);
});

test("a pairing code is dropped after five wrong tries", async () => {
  const code = tg.startPairing().pairing!.code;
  for (let i = 0; i < 5; i++) push(msg(STRANGER, `GUESS${i}AA`));
  await drained();
  assert.equal(tg.telegramState().pairing, null);
  push(msg(STRANGER, code));
  await drained();
  assert.equal(tg.owner()!.id, OWNER, "the late right answer pairs nobody");
});

test("the owner's message runs a turn in the Telegram chat and the reply comes back", async () => {
  sent.length = 0;
  prompts = [];
  fakeEngine("Here is your answer.");
  push(msg(OWNER, "what is on today?"));
  await until(() => texts().includes("Here is your answer."), "reply sent");
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].startsWith(tg.TELEGRAM_RULES), "the turn is told it came by phone and what must wait");
  assert.ok(prompts[0].endsWith("what is on today?"));
  assert.ok(sent.some((s) => s.method === "sendChatAction"), "shows typing while it works");
  const chat = sessions.list().find((s) => s.title === "Telegram");
  assert.ok(chat, "it is an ordinary chat in the sidebar");

  // a stranger, a group the owner is in, and a bot are still ignored
  const before = prompts.length;
  push(
    msg(STRANGER, "run rm -rf"),
    { update_id: nextUpdate++, message: { message_id: 2, date: now(), text: "hi all", from: { id: OWNER }, chat: { id: -900, type: "supergroup" } } },
    { update_id: nextUpdate++, message: { message_id: 3, date: now(), text: "beep", from: { id: OWNER, is_bot: true }, chat: { id: OWNER, type: "private" } } },
  );
  await drained();
  assert.equal(prompts.length, before);
  assert.equal(texts(STRANGER).length, 0);
  assert.equal(sent.filter((s) => s.chat_id === -900).length, 0);
});

test("commands: /new starts a fresh chat, /stop stops a running turn, a second message waits its turn", async () => {
  sent.length = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fakeEngine("slow answer", gate);
  push(msg(OWNER, "take your time"));
  await until(() => prompts.at(-1)?.endsWith("take your time") ?? false, "turn running");
  push(msg(OWNER, "and another thing"));
  await until(() => texts().some((t) => t.startsWith("Still working")), "busy notice");
  push(msg(OWNER, "/stop"));
  await until(() => texts().includes("Stopped."), "/stop answered");
  release();
  await drained();

  const first = sessions.list().filter((s) => s.title === "Telegram").length;
  push(msg(OWNER, "/new"));
  await until(() => texts().some((t) => t.startsWith("Fresh chat")), "/new answered");
  assert.equal(sessions.list().filter((s) => s.title === "Telegram").length, first + 1);

  push(msg(OWNER, "/help"), msg(OWNER, "/frobnicate"), msg(OWNER, undefined));
  await until(() => texts().some((t) => t.startsWith("I don't know /frobnicate")) && texts().some((t) => t.startsWith("Text only")), "help and text-only");
});

test("a message that arrives long after it was sent is not run", async () => {
  sent.length = 0;
  const before = prompts.length;
  const late = msg(OWNER, "delete everything");
  (late.message as { date: number }).date = now() - 3600;
  push(late);
  await until(() => texts().some((t) => t.includes("reached BitBull late")), "late notice");
  assert.equal(prompts.length, before);
});

test("who is paired can't be planted or edited from the data folder", async () => {
  const saved = (db.prepare("SELECT value FROM meta WHERE key = 'telegram_owner'").get() as { value: string }).value;
  const set = (v: string) => db.prepare("UPDATE meta SET value = ? WHERE key = 'telegram_owner'").run(v);

  // another account written over the record: the signature no longer matches
  set(JSON.stringify({ ...JSON.parse(saved), id: STRANGER }));
  assert.equal(tg.owner(), null);
  const before = prompts.length;
  push(msg(STRANGER, "I am the owner now"));
  await drained();
  assert.equal(prompts.length, before);
  assert.equal(texts(STRANGER).length, 0);

  set(JSON.stringify({ id: STRANGER, name: "x", pairedAt: Date.now(), sig: "00".repeat(32) }));
  assert.equal(tg.owner(), null);
  set("not json");
  assert.equal(tg.owner(), null);

  set(saved);
  assert.equal(tg.owner()!.id, OWNER);
});

test("scheduled results go to the owner's Telegram when the schedule asks for it", async () => {
  sent.length = 0;
  fakeEngine("3 new issues, nothing urgent.");
  const quiet = schedules.create({ name: "Quiet one", prompt: "check", spec: { kind: "interval", everyMinutes: 60 } });
  const loud = schedules.create({ name: "Morning check", prompt: "check", spec: { kind: "interval", everyMinutes: 60 }, telegram: true });
  assert.equal(quiet.telegram, false);
  assert.equal(schedules.get(loud.id)!.telegram, true);
  runSchedule(quiet.id);
  runSchedule(loud.id);
  await until(() => texts().length >= 1, "schedule result sent");
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(texts(), ["⏰ Morning check\n\n3 new issues, nothing urgent."]);
  assert.equal(schedules.update(loud.id, { telegram: false })!.telegram, false);
});

test("the test message and unpairing", async () => {
  sent.length = 0;
  assert.equal(await tg.notifyOwner("ping"), true);
  assert.deepEqual(texts(), ["ping"]);
  assert.equal(tg.unpair(), true);
  assert.equal(tg.telegramState().paired, null);
  assert.equal(await tg.notifyOwner("ping"), false, "nobody to send to");
  const before = prompts.length;
  push(msg(OWNER, "still there?"));
  await drained();
  assert.equal(prompts.length, before, "after unpairing even the old owner is ignored");
});

test("a new token unpairs, a bad one is reported without leaking it, no token closes the door", async () => {
  // pair again, then change the bot
  const code = tg.startPairing().pairing!.code;
  push(msg(OWNER, code));
  await until(() => !!tg.owner(), "paired again");

  assert.equal(builtIn("api.telegram.org"), false, "the stand-in host is what is open here, not the real one");
  assert.equal(builtIn("127.0.0.1"), true);

  const BAD = fakeToken("987654321", "b");
  process.env.TELEGRAM_BOT_TOKEN = BAD;
  reloadConfig();
  assert.equal(tg.owner(), null, "the old pairing was signed with the old token");
  tg.syncTelegram();
  await until(() => tg.telegramState().status === "error", "bad token noticed");
  const s = tg.telegramState();
  assert.match(s.error, /didn't accept that token/);
  assert.ok(!JSON.stringify(s).includes(BAD));
  assert.throws(() => tg.startPairing(), /token/);
  assert.equal(redact(`leak ${BAD} here`), "leak [REDACTED] here", "the activity log redacts the token");
  for (const e of recent({ limit: 500 })) assert.ok(!JSON.stringify(e).includes(TOKEN) && !JSON.stringify(e).includes(BAD));

  process.env.TELEGRAM_BOT_TOKEN = "not-a-token";
  reloadConfig();
  tg.syncTelegram();
  assert.match(tg.telegramState().error, /doesn't look like a bot token/);
  assert.ok(!seenTokens.has("not-a-token"), "a malformed token is never sent anywhere");

  process.env.TELEGRAM_BOT_TOKEN = "";
  reloadConfig();
  tg.syncTelegram();
  assert.equal(tg.telegramState().status, "off");
  assert.equal(tg.telegramState().configured, false);
  assert.equal(builtIn("127.0.0.1"), false, "no bot, no opening in the proxy");
  assert.equal(config.integrations.telegram.botToken, "");
});

test("a token someone else is polling is explained", async () => {
  conflict = true;
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  reloadConfig();
  tg.syncTelegram();
  await until(() => /Something else is using this bot's token/.test(tg.telegramState().error), "conflict explained");
  conflict = false;
  tg._stopTelegram();
});
