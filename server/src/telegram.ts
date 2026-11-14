/**
 * Telegram: talk to BitBull from your phone, through a bot that is yours alone.
 *
 * Private and personal by design. The owner makes a bot with @BotFather, pastes its token in
 * Settings, and pairs their own Telegram account with a one-time code shown in BitBull. After
 * that the bot answers exactly one account, in its private chat. Everyone else, every group and
 * every channel is ignored without a reply, so a stranger who finds the bot learns nothing.
 *
 * How it connects: long polling (getUpdates). BitBull calls out to Telegram; nothing has to
 * reach this machine, so no port, tunnel or public address is needed.
 *
 * What a message does: it becomes a turn in one ordinary chat ("Telegram" in the sidebar), so
 * everything said from the phone is on screen in BitBull too. Text only for now. Nobody is at
 * the BitBull screen when a message arrives by phone, so the turn is told to prepare anything
 * that publishes, sends, deletes or spends and leave it for approval in BitBull (TELEGRAM_RULES).
 *
 * Trust:
 *  - The token is a vault secret and is kept out of the agent's environment and output like
 *    BitBull's other keys. It is sent only to config.integrations.telegram.apiUrl (.env-only).
 *  - Who is paired is kept in the database, which lives in DATA_DIR where the agent's shell can
 *    write. So the record carries a signature made with the bot token: a record the agent
 *    planted or edited doesn't verify and counts as "not paired". A new token unpairs for the
 *    same reason, which is what you want when the bot changes.
 *  - The pairing code lives in memory only, for ten minutes, and is dropped after five wrong tries.
 */
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { record } from "./activity.js";
import { config } from "./config.js";
import { db, sessions } from "./db.js";
import { chatModels, type ModelInfo } from "./models.js";
import { abortTurn, activeTurnId, collectTurn, startTurn } from "./turns.js";

// ---------- small pieces ----------

const token = () => config.integrations.telegram.botToken.trim();
export const validToken = (t: string) => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t.trim());

const meta = {
  get(key: string): string | undefined {
    return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined)?.value;
  },
  set(key: string, value: string) {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  },
  del(key: string) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  },
};

/** Never let the token into an error message or a log line (it is part of every request URL). */
const scrub = (s: string) => {
  const t = token();
  return (t ? s.split(t).join("[token]") : s).replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[token]");
};

class TelegramError extends Error {
  constructor(
    message: string,
    readonly code = 0,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

/** One Bot API call. `tok` is passed in so a call can't outlive a token change. */
async function call<T = unknown>(tok: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000, signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${config.integrations.telegram.apiUrl}/bot${tok}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } | null;
    if (!body || body.ok !== true) {
      throw new TelegramError(scrub(body?.description || `HTTP ${res.status}`).slice(0, 200), body?.error_code ?? res.status, body?.parameters?.retry_after ?? 0);
    }
    return body.result as T;
  } catch (e) {
    if (e instanceof TelegramError) throw e;
    const why = signal?.aborted ? "stopped" : ctl.signal.aborted ? "timed out" : e instanceof Error ? e.message : String(e);
    throw new TelegramError(scrub(`Couldn't reach Telegram (${why})`).slice(0, 200));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ---------- who is paired ----------

export interface Owner {
  id: number;
  name: string;
  pairedAt: number;
}
const OWNER_KEY = "telegram_owner";
const sign = (tok: string, id: number, pairedAt: number) => createHmac("sha256", tok).update(`bitbull-telegram-owner:${id}:${pairedAt}`).digest("hex");

function sameText(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The paired account, or null: nothing saved, no token, or a record that this token didn't sign. */
export function owner(): Owner | null {
  const tok = token();
  const raw = meta.get(OWNER_KEY);
  if (!tok || !raw) return null;
  try {
    const o = JSON.parse(raw) as { id?: unknown; name?: unknown; pairedAt?: unknown; sig?: unknown };
    if (!Number.isSafeInteger(o.id) || !Number.isSafeInteger(o.pairedAt) || typeof o.sig !== "string") return null;
    if (!sameText(o.sig, sign(tok, o.id as number, o.pairedAt as number))) return null;
    return { id: o.id as number, name: typeof o.name === "string" ? o.name.slice(0, 80) : "", pairedAt: o.pairedAt as number };
  } catch {
    return null;
  }
}

function setOwner(tok: string, id: number, name: string) {
  const pairedAt = Date.now();
  meta.set(OWNER_KEY, JSON.stringify({ id, name: name.slice(0, 80), pairedAt, sig: sign(tok, id, pairedAt) }));
}

export function unpair() {
  const had = !!meta.get(OWNER_KEY);
  meta.del(OWNER_KEY);
  pairing = null;
  if (had) record({ level: "info", source: "telegram", message: "Telegram unpaired: the bot answers nobody until you pair again" });
  return had;
}

// ---------- pairing ----------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
const CODE_LENGTH = 8;
const PAIRING_MS = 10 * 60_000;
const MAX_WRONG = 5;

let pairing: { code: string; expiresAt: number; wrong: number } | null = null;

const livePairing = () => {
  if (pairing && Date.now() > pairing.expiresAt) pairing = null;
  return pairing;
};

/** Make a one-time code. The first private message that carries it becomes the owner. */
export function startPairing() {
  if (!bot) throw new Error(state.error || "The bot isn't connected yet. Check the token, then try again.");
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  pairing = { code, expiresAt: Date.now() + PAIRING_MS, wrong: 0 };
  return telegramState();
}

export function cancelPairing() {
  pairing = null;
  return telegramState();
}

// ---------- the bot ----------

interface Bot {
  id: number;
  username: string;
  name: string;
}
let bot: Bot | null = null;
const state: { status: "off" | "connecting" | "on" | "error"; error: string; ignored: number } = { status: "off", error: "", ignored: 0 };

/** What Settings shows. Never includes the token. */
export function telegramState() {
  const p = livePairing();
  const o = owner();
  return {
    configured: !!token(),
    status: state.status,
    error: state.error,
    bot: bot ? { username: bot.username, name: bot.name, link: `https://t.me/${bot.username}` } : null,
    paired: o ? { name: o.name, pairedAt: o.pairedAt } : null,
    pairing: p && bot ? { code: p.code, expiresAt: p.expiresAt, link: `https://t.me/${bot.username}?start=${p.code}`, command: `/start ${p.code}` } : null,
    /** messages from anyone but the owner since BitBull started (never answered) */
    ignored: state.ignored,
  };
}

// ---------- sending ----------

/** Telegram's limit is 4096 characters a message; stay under it and break at a paragraph or line. */
export const CHUNK = 3900;
const MAX_CHUNKS = 6;

export function splitMessage(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let rest = text.replace(/\r\n/g, "\n").trim();
  while (rest.length > size) {
    const head = rest.slice(0, size);
    let cut = head.lastIndexOf("\n\n");
    if (cut < size * 0.5) cut = head.lastIndexOf("\n");
    if (cut < size * 0.5) cut = head.lastIndexOf(" ");
    if (cut < size * 0.5) cut = size;
    // never cut a surrogate pair (an emoji) in half
    if (cut === size && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function send(tok: string, chatId: number, text: string) {
  let parts = splitMessage(text);
  if (parts.length > MAX_CHUNKS) parts = [...parts.slice(0, MAX_CHUNKS), "(Cut short here. The full reply is in the Telegram chat in BitBull.)"];
  for (const part of parts) {
    try {
      await call(tok, "sendMessage", { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
    } catch (e) {
      // told to slow down: wait once as asked, then try that part again
      if (e instanceof TelegramError && e.code === 429 && e.retryAfter > 0 && e.retryAfter <= 30) {
        await new Promise((r) => setTimeout(r, e.retryAfter * 1000));
        await call(tok, "sendMessage", { chat_id: chatId, text: part, link_preview_options: { is_disabled: true } });
      } else throw e;
    }
  }
}

/** Send something to the paired account (schedule results, the test button). False when not paired or not sent. */
export async function notifyOwner(text: string): Promise<boolean> {
  const tok = token();
  const o = owner();
  if (!tok || !o || !text.trim()) return false;
  try {
    await send(tok, o.id, text);
    return true;
  } catch (e) {
    record({ level: "warn", source: "telegram", message: `Couldn't send to Telegram: ${e instanceof Error ? e.message : String(e)}` });
    return false;
  }
}

// ---------- a message from the owner ----------

/** Said at the top of every turn that came in by Telegram. */
export const TELEGRAM_RULES = [
  "[Sent by the owner from their phone, through their private Telegram bot. Nobody is at the BitBull screen.]",
  "Reply in plain text that reads well on a phone: short, no tables, no headings. Don't publish, send, post, delete, spend money or make any change that can't be undone from here: prepare it and say it is waiting for approval in BitBull. Anything you need approved on screen (network access, for one) can't be answered from Telegram, so say what is waiting rather than waiting for it.",
  "",
].join("\n");

const SESSION_KEY = "telegram_session";
const HELP = [
  "This is your private line to BitBull. Send a message and it answers here; the same chat is in BitBull under “Telegram”.",
  "",
  "/new  start a fresh chat",
  "/stop  stop what it is doing",
  "/model  which model this chat uses; /model <name> changes it",
  "/models <word>  list models matching a word",
  "/help  this message",
  "",
  "Text only for now. Anything that publishes, sends, deletes or spends waits for your approval in BitBull.",
].join("\n");

function chatSession(fresh = false) {
  const id = meta.get(SESSION_KEY);
  const existing = id ? sessions.get(id) : undefined;
  if (!fresh && existing && !existing.archived_at) return existing;
  // a fresh chat keeps the model you chose for the last one
  const s = sessions.create({ title: "Telegram", engine: existing?.engine ?? config.agent.defaultEngine, model: existing?.model ?? config.agent.defaultModel, projectId: null });
  meta.set(SESSION_KEY, s.id);
  return s;
}

// ---------- choosing the model from the phone ----------

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Models a few typed words could mean: the exact id or name if there is one, else every model
 * whose id or name contains all the words ("deepseek flash" finds deepseek-v4.1-flash).
 */
export function matchModels(all: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim();
  if (!q) return [];
  const exact = all.filter((m) => m.id.toLowerCase() === q.toLowerCase() || m.name.toLowerCase() === q.toLowerCase());
  if (exact.length) return exact;
  const whole = all.filter((m) => squash(m.id) === squash(q) || squash(m.name) === squash(q));
  if (whole.length) return whole;
  const words = q.toLowerCase().split(/\s+/).map(squash).filter(Boolean);
  return all.filter((m) => {
    const hay = `${squash(m.id)} ${squash(m.name)}`;
    return words.every((w) => hay.includes(w));
  });
}

const modelLine = (m: ModelInfo) => (m.name && m.name !== m.id ? `${m.id}  (${m.name})` : m.id);
const MAX_LISTED = 25;

async function modelCommand(tok: string, chatId: number, cmd: "model" | "models", arg: string) {
  const session = chatSession();
  const all = await chatModels().catch(() => [] as ModelInfo[]);
  if (!all.length) return send(tok, chatId, `This chat uses ${session.model}. I couldn't load the model list just now, so it can't be changed from here; try again in a minute.`);
  // the Claude engine only runs models served the Anthropic way
  const usable = session.engine === "claude" ? all.filter((m) => m.api === "anthropic" || m.gateway === "ditto-router") : all;

  if (cmd === "model" && !arg) {
    return send(tok, chatId, `This chat uses ${session.model}.\n\nTo change it: /model <name>, for example /model deepseek flash. /models <word> lists what matches.`);
  }
  const found = arg ? matchModels(usable, arg) : usable;
  if (cmd === "models" || found.length !== 1) {
    if (!found.length) return send(tok, chatId, `No model matches “${arg.slice(0, 60)}”. Try one word, like /models deepseek.`);
    if (cmd === "models" && !arg && found.length > MAX_LISTED) return send(tok, chatId, `${found.length} models are available: too many to list. Narrow it with a word, like /models claude or /models flash.\n\nThis chat uses ${session.model}.`);
    const lines = found.slice(0, MAX_LISTED).map(modelLine);
    const more = found.length > MAX_LISTED ? `\n…and ${found.length - MAX_LISTED} more. Add a word to narrow it.` : "";
    return send(tok, chatId, `${cmd === "model" ? `${found.length} models match. Send /model with one of these:\n\n` : ""}${lines.join("\n")}${more}`);
  }
  const m = found[0];
  if (m.id === session.model) return send(tok, chatId, `This chat already uses ${m.id}.`);
  if (activeTurnId(session.id)) return send(tok, chatId, "It's still working on your last message. Send /stop first, or wait, then change the model.");
  sessions.update(session.id, { model: m.id });
  record({ level: "info", source: "telegram", message: `Telegram chat's model changed to ${m.id}`, sessionId: session.id, sessionTitle: session.title });
  return send(tok, chatId, `Done. This chat now uses ${modelLine(m)}, here and in BitBull.`);
}

/** Messages older than this when they arrive (BitBull was off) are not run. */
const STALE_MS = 15 * 60_000;

interface TgMessage {
  message_id: number;
  date: number;
  text?: string;
  from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  chat: { id: number; type: string };
}

async function typingWhile<T>(tok: string, chatId: number, work: Promise<T>): Promise<T> {
  const ping = () => void call(tok, "sendChatAction", { chat_id: chatId, action: "typing" }, 10_000).catch(() => {});
  ping();
  const timer = setInterval(ping, 4500);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

async function ownerMessage(tok: string, m: TgMessage) {
  const chatId = m.chat.id;
  const text = (m.text ?? "").trim();
  if (!text) return send(tok, chatId, "Text only for now: I can't read photos, voice notes or files sent here yet.");

  const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
  if (cmd === "start" || cmd === "help") return send(tok, chatId, HELP);
  if (cmd === "new") {
    const cur = meta.get(SESSION_KEY);
    if (cur && activeTurnId(cur)) return send(tok, chatId, "It's still working on your last message. Send /stop first, then /new.");
    chatSession(true);
    return send(tok, chatId, "Fresh chat started. What do you need?");
  }
  if (cmd === "stop") {
    const cur = meta.get(SESSION_KEY);
    return send(tok, chatId, cur && abortTurn(cur) ? "Stopped." : "Nothing was running.");
  }
  if (cmd === "model" || cmd === "models") return modelCommand(tok, chatId, cmd, text.replace(/^\/\S+\s*/, ""));
  if (cmd) return send(tok, chatId, `I don't know /${cmd}.\n\n${HELP}`);

  const session = chatSession();
  if (activeTurnId(session.id)) return send(tok, chatId, "Still working on your last message. Send /stop to cancel it, or wait for the reply.");

  record({ level: "info", source: "telegram", message: "Message from Telegram: turn started", sessionId: session.id, sessionTitle: session.title });
  const { turnId } = startTurn(session, { prompt: TELEGRAM_RULES + text, model: session.model });
  // not awaited by the poll loop: /stop has to get through while this runs
  void typingWhile(tok, chatId, collectTurn(turnId))
    .then(({ events, status }) => send(tok, chatId, replyText(events, status)))
    .catch((e) => record({ level: "warn", source: "telegram", message: `Couldn't send the reply to Telegram: ${e instanceof Error ? e.message : String(e)}`, sessionId: session.id }));
}

/** The words of a finished turn, as one message: its text, then anything that went wrong. */
export function replyText(events: Array<{ event: { type: string; delta?: string; message?: string } }>, status: string): string {
  let text = "";
  const errors: string[] = [];
  for (const { event: ev } of events) {
    if (ev.type === "text" && ev.delta) text += ev.delta;
    if (ev.type === "error" && ev.message) errors.push(ev.message);
  }
  text = text.trim();
  if (status === "aborted") return text ? `${text}\n\n(Stopped before it finished.)` : "Stopped.";
  if (errors.length) return [text, `Something went wrong: ${errors[errors.length - 1].slice(0, 500)}`].filter(Boolean).join("\n\n");
  return text || "Done, with nothing to say in words. Open the Telegram chat in BitBull to see what it did.";
}

const lastIgnoredLog = new Map<number, number>();
function ignore(m: TgMessage) {
  state.ignored++;
  // one line an hour per sender: enough to notice, not enough for a stranger to flood the log
  const who = m.from?.id ?? 0;
  const now = Date.now();
  if (now - (lastIgnoredLog.get(who) ?? 0) < 3600_000) return;
  lastIgnoredLog.set(who, now);
  if (lastIgnoredLog.size > 500) lastIgnoredLog.delete(lastIgnoredLog.keys().next().value!);
  record({ level: "warn", source: "telegram", message: `Ignored a Telegram message from an account that isn't paired (${m.chat.type} chat, sender ${who})`, detail: "Not answered. Only the paired account's private chat with the bot is." });
}

/** One update from Telegram. Exported for tests. */
export async function handleMessage(tok: string, m: TgMessage) {
  // only people, only one-to-one chats: never a group, a channel or another bot
  if (!m?.from || m.from.is_bot || m.chat?.type !== "private" || m.chat.id !== m.from.id) return ignore(m);
  const text = (m.text ?? "").trim();
  const o = owner();

  // pairing: the code, alone or as "/start CODE" (what the t.me link sends)
  const p = livePairing();
  if (p) {
    const offered = (/^\/start(?:@\w+)?\s+(\S+)$/i.exec(text)?.[1] ?? text).toUpperCase();
    if (offered.length === p.code.length && sameText(offered, p.code)) {
      pairing = null;
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || m.from.username || "";
      setOwner(tok, m.from.id, name);
      record({ level: "info", source: "telegram", message: `Telegram paired${name ? ` with ${name}` : ""}: the bot now answers this account only` });
      return send(tok, m.chat.id, `Paired. This bot now answers you and nobody else.\n\n${HELP}`);
    }
    if (!o || o.id !== m.from.id) {
      if (++p.wrong >= MAX_WRONG) {
        pairing = null;
        record({ level: "warn", source: "telegram", message: "Pairing code cancelled after too many wrong tries. Make a new one in Settings." });
      }
      return ignore(m);
    }
  }
  if (!o || o.id !== m.from.id) return ignore(m);
  if (Date.now() - m.date * 1000 > STALE_MS) return send(tok, m.chat.id, "That message reached BitBull late (it was off or offline), so it wasn't run. Send it again if you still want it.");
  return ownerMessage(tok, m);
}

// ---------- polling ----------

const OFFSET_KEY = "telegram_offset";
let run: { token: string; stop: AbortController } | null = null;

function loadOffset(botId: number) {
  try {
    const o = JSON.parse(meta.get(OFFSET_KEY) ?? "{}") as { bot?: number; offset?: number };
    return o.bot === botId && Number.isSafeInteger(o.offset) ? (o.offset as number) : 0;
  } catch {
    return 0;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

async function poll(tok: string, signal: AbortSignal) {
  let wait = 2000;
  // who am I: also the check that the token is good
  while (!signal.aborted && !bot) {
    try {
      const me = await call<{ id: number; username?: string; first_name?: string }>(tok, "getMe", {}, 15_000, signal);
      bot = { id: me.id, username: me.username ?? "", name: me.first_name ?? "" };
      state.status = "on";
      state.error = "";
      record({ level: "info", source: "telegram", message: `Telegram connected as @${bot.username}${owner() ? "" : " (not paired yet)"}` });
    } catch (e) {
      if (signal.aborted) return;
      const err = e as TelegramError;
      state.status = "error";
      state.error = err.code === 401 || err.code === 404 ? "Telegram didn't accept that token. Copy it again from @BotFather." : err.message;
      if (err.code === 401 || err.code === 404) return; // a bad token stays bad: wait for a new one
      await sleep(wait, signal);
      wait = Math.min(wait * 2, 60_000);
    }
  }
  if (!bot) return;
  let offset = loadOffset(bot.id);
  wait = 2000;
  while (!signal.aborted) {
    try {
      const updates = await call<Array<{ update_id: number; message?: TgMessage }>>(tok, "getUpdates", { offset, timeout: 25, allowed_updates: ["message"] }, 40_000, signal);
      if (state.status !== "on") {
        state.status = "on";
        state.error = "";
      }
      wait = 2000;
      for (const u of updates) {
        offset = u.update_id + 1;
        // saved before handling: a message that crashes the handler must not be replayed forever
        meta.set(OFFSET_KEY, JSON.stringify({ bot: bot.id, offset }));
        if (!u.message) continue;
        try {
          await handleMessage(tok, u.message);
        } catch (e) {
          record({ level: "warn", source: "telegram", message: `Telegram message not handled: ${e instanceof Error ? scrub(e.message) : String(e)}` });
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      const err = e as TelegramError;
      state.status = "error";
      if (err.code === 401 || err.code === 404) {
        state.error = "Telegram stopped accepting the token (revoked?). Paste the new one from @BotFather.";
        return;
      }
      state.error =
        err.code === 409
          ? "Something else is using this bot's token (another BitBull, another program, or a webhook). A bot can only be read from one place."
          : err.message;
      await sleep(err.code === 409 ? 30_000 : wait, signal);
      wait = Math.min(wait * 2, 60_000);
    }
  }
}

/** Bring polling in line with the current token: start, stop, or restart on a new token. */
export function syncTelegram() {
  const tok = token();
  if (run && run.token === tok) return;
  if (run) {
    run.stop.abort();
    run = null;
    bot = null;
    pairing = null;
  }
  if (!tok) {
    state.status = "off";
    state.error = "";
    return;
  }
  if (!validToken(tok)) {
    state.status = "error";
    state.error = "That doesn't look like a bot token (it should look like 123456789:AA…). Copy it again from @BotFather.";
    run = { token: tok, stop: new AbortController() };
    return;
  }
  state.status = "connecting";
  state.error = "";
  const stop = new AbortController();
  run = { token: tok, stop };
  void poll(tok, stop.signal).catch((e) => {
    state.status = "error";
    state.error = scrub(e instanceof Error ? e.message : String(e));
  });
}

/**
 * Follows the token wherever it changes (Settings, .env reload, the vault locking or unlocking)
 * by looking every few seconds, rather than hooking every place that can change it.
 */
export function startTelegram() {
  syncTelegram();
  setInterval(syncTelegram, 3000).unref();
}

/** For tests. */
export function _stopTelegram() {
  run?.stop.abort();
  run = null;
  bot = null;
  pairing = null;
  state.status = "off";
  state.error = "";
  state.ignored = 0;
  lastIgnoredLog.clear();
}
export const _pairingCode = () => livePairing()?.code;
