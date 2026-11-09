/**
 * Which model for this? Your own usage history per model, and an advisor that picks three models
 * for a task from SayGM's live catalogue.
 *
 * No model knows today's catalogue or prices from its training, so the advisor is never asked
 * cold: code first keeps only models that can do the job at all (every BitBull chat is an agent
 * with tools; images need vision), then the advisor model gets that shortlist as a table, with
 * live prices and how each model has done for you here, and must choose from it. It also guesses
 * how big the task is; the cost per pick is worked out here from the live prices, not by the
 * model.
 *
 * The advisor is ADVISOR_MODEL (default: SMALL_MODEL), a cheap model, because choosing from a
 * table is easy work. "Ask a stronger model" uses ADVISOR_STRONG_MODEL (default: DEFAULT_MODEL).
 */
import { config } from "./config.js";
import { db } from "./db.js";
import { estimateCost, listModels, type ModelInfo } from "./models.js";
import { record } from "./activity.js";

/* ---------------- your usage ---------------- */

export interface ModelUsage {
  id: string;
  /** turns run on this model, and how they ended */
  turns: number;
  done: number;
  errors: number;
  /** stopped by you, or cut off by a restart */
  stopped: number;
  /** replies with a usage record, and what they cost (SayGM's live prices when the engine had none) */
  replies: number;
  totalCostUsd: number;
  avgCostUsd?: number;
  avgInputTokens?: number;
  avgOutputTokens?: number;
  avgSeconds?: number;
  lastUsed?: number;
}

/** Per model, from the turns and replies BitBull has stored. Read-only; nothing new is recorded. */
export function usageByModel(): ModelUsage[] {
  const turnRows = db
    .prepare(
      `SELECT model,
              COUNT(*) AS turns,
              SUM(status = 'done') AS done,
              SUM(status = 'error') AS errors,
              SUM(status IN ('aborted', 'interrupted')) AS stopped,
              MAX(started_at) AS last_used,
              AVG(CASE WHEN ended_at IS NOT NULL AND status = 'done' THEN ended_at - started_at END) AS avg_ms
         FROM turns GROUP BY model`,
    )
    .all() as Array<{ model: string; turns: number; done: number; errors: number; stopped: number; last_used: number | null; avg_ms: number | null }>;
  const msgRows = db
    .prepare(
      `SELECT model,
              COUNT(*) AS replies,
              SUM(json_extract(usage_json, '$.costUsd')) AS cost,
              AVG(json_extract(usage_json, '$.costUsd')) AS avg_cost,
              AVG(json_extract(usage_json, '$.inputTokens')) AS avg_in,
              AVG(json_extract(usage_json, '$.outputTokens')) AS avg_out,
              MAX(created_at) AS last_reply
         FROM messages
        WHERE role = 'assistant' AND model IS NOT NULL AND usage_json IS NOT NULL AND json_valid(usage_json)
        GROUP BY model`,
    )
    .all() as Array<{ model: string; replies: number; cost: number | null; avg_cost: number | null; avg_in: number | null; avg_out: number | null; last_reply: number | null }>;

  const out = new Map<string, ModelUsage>();
  const get = (id: string) => {
    let u = out.get(id);
    if (!u) out.set(id, (u = { id, turns: 0, done: 0, errors: 0, stopped: 0, replies: 0, totalCostUsd: 0 }));
    return u;
  };
  for (const r of turnRows) {
    const u = get(r.model);
    u.turns = r.turns;
    u.done = r.done ?? 0;
    u.errors = r.errors ?? 0;
    u.stopped = r.stopped ?? 0;
    if (r.last_used) u.lastUsed = r.last_used;
    if (r.avg_ms) u.avgSeconds = Math.round(r.avg_ms / 100) / 10;
  }
  for (const r of msgRows) {
    const u = get(r.model);
    u.replies = r.replies;
    u.totalCostUsd = r.cost ?? 0;
    if (r.avg_cost !== null) u.avgCostUsd = r.avg_cost;
    if (r.avg_in !== null) u.avgInputTokens = Math.round(r.avg_in);
    if (r.avg_out !== null) u.avgOutputTokens = Math.round(r.avg_out);
    if (r.last_reply && (!u.lastUsed || r.last_reply > u.lastUsed)) u.lastUsed = r.last_reply;
  }
  return [...out.values()].sort((a, b) => b.turns - a.turns || b.replies - a.replies || a.id.localeCompare(b.id));
}

/* ---------------- the shortlist ---------------- */

export interface Needs {
  vision: boolean;
}

/** What the task says it needs that a model either has or hasn't. Everything softer is the advisor's call. */
export function needsOf(task: string): Needs {
  return { vision: /\b(images?|photos?|pictures?|screenshots?|diagrams?|scans?|scanned|ocr|charts?|logos?|drawings?|handwrit\w*|png|jpe?g)\b/i.test(task) };
}

const blended = (m: ModelInfo) => (m.price ? 3 * m.price.input + m.price.output : Infinity);

/** Every model that could do it, models you use first, then cheapest first. Capped so the table stays small. */
export function shortlist(models: ModelInfo[], needs: Needs, usage: Map<string, ModelUsage>, cap = 150): ModelInfo[] {
  return models
    .filter((m) => m.tools !== false && !!m.price && (!needs.vision || m.vision))
    .sort((a, b) => (usage.get(b.id)?.turns ?? 0) - (usage.get(a.id)?.turns ?? 0) || blended(a) - blended(b) || a.id.localeCompare(b.id))
    .slice(0, cap);
}

const money = (n: number) => (n >= 1 ? n.toFixed(2) : n.toFixed(3));

export function tableRow(m: ModelInfo, u?: ModelUsage): string {
  const bits = [
    m.id,
    m.provider ?? m.family,
    m.price ? `$${money(m.price.input)}/$${money(m.price.output)}` : "?",
    m.contextLength ? `${Math.round(m.contextLength / 1000)}k` : "?",
    [m.vision ? "vision" : "", m.confidential ? "TEE" : "", m.tier ?? ""].filter(Boolean).join(" ") || "-",
    u && u.turns
      ? `${u.turns} turns, ${Math.round((100 * u.errors) / u.turns)}% errors${u.avgCostUsd !== undefined ? `, avg $${u.avgCostUsd.toFixed(4)}/turn` : ""}`
      : "not used yet",
  ];
  return bits.join(" | ");
}

/* ---------------- the advice ---------------- */

export type Role = "best-value" | "best-quality" | "cheapest";
const ROLES: Role[] = ["best-value", "best-quality", "cheapest"];

export interface Pick {
  id: string;
  name: string;
  role: Role;
  why: string;
  pros: string[];
  cons: string[];
  estCostUsd?: number;
  usage?: ModelUsage;
}

export interface Advice {
  task: string;
  advisor: string;
  picks: Pick[];
  estimate: { inputTokens: number; outputTokens: number; turns: number };
  needs: Needs;
  /** what asking cost */
  costUsd?: number;
  considered: number;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 160)).filter(Boolean).slice(0, 4) : []);
const num = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt);

/**
 * The advisor's reply, checked: JSON (code fences tolerated), only models from the shortlist,
 * one per role, sizes clamped. Anything else is dropped rather than shown.
 */
export function parseAdvice(text: string, allowed: Map<string, ModelInfo>): { picks: Omit<Pick, "estCostUsd" | "usage">[]; estimate: Advice["estimate"] } {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("The advisor didn't answer in the expected format");
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text.slice(a, b + 1));
  } catch {
    throw new Error("The advisor's answer wasn't valid JSON");
  }
  const e = (j.estimate ?? {}) as Record<string, unknown>;
  const estimate = { inputTokens: num(e.inputTokens, 1000, 5_000_000, 30_000), outputTokens: num(e.outputTokens, 100, 1_000_000, 3_000), turns: num(e.turns, 1, 200, 1) };
  const picks: Omit<Pick, "estCostUsd" | "usage">[] = [];
  for (const raw of Array.isArray(j.picks) ? j.picks : []) {
    const p = raw as Record<string, unknown>;
    const id = str(p.id, 120);
    const role = str(p.role, 20) as Role;
    const m = allowed.get(id);
    if (!m || !ROLES.includes(role) || picks.some((x) => x.role === role || x.id === id)) continue;
    picks.push({ id, name: m.name, role, why: str(p.why, 400), pros: list(p.pros), cons: list(p.cons) });
  }
  if (!picks.length) throw new Error("The advisor picked no model from the list");
  picks.sort((x, y) => ROLES.indexOf(x.role) - ROLES.indexOf(y.role));
  return { picks, estimate };
}

function prompt(task: string, rows: string[], typicalIn: number): { system: string; user: string } {
  const system = [
    "You pick models for a task in BitBull, an AI agent app. Every chat turn there is an agent turn: the model gets a large system prompt and tools (files, shell, web search) and may call them several times, so input tokens per turn are high.",
    "Choose ONLY from the table you are given. It is the live catalogue with today's prices; your own knowledge of models and prices may be out of date, so where it disagrees with the table, the table wins. A model's record with this user (turns, error rate, average cost per turn) is real evidence: weigh it.",
    "Pick three different models, one for each role:",
    '- "best-value": the best results for the money for THIS task',
    '- "best-quality": the strongest result, cost secondary',
    '- "cheapest": the cheapest that will still do this task acceptably',
    'Also estimate the task\'s size in BitBull: total input tokens, output tokens and number of turns across the whole task.',
    "Pros and cons: short, concrete, about this task (not generic praise). At most 3 each.",
    'Reply with JSON only, no prose, in exactly this shape:',
    '{"estimate":{"inputTokens":0,"outputTokens":0,"turns":0},"picks":[{"id":"","role":"best-value","why":"","pros":[""],"cons":[""]}]}',
  ].join("\n");
  const user = [
    `Task: ${task}`,
    "",
    `A typical turn for this user uses about ${typicalIn.toLocaleString("en-GB")} input tokens.`,
    "",
    "Models (id | maker | $ per million tokens in/out | context | features | this user's record):",
    ...rows,
  ].join("\n");
  return { system, user };
}

/* ---------------- one plain call to a model through SayGM ---------------- */

interface Reply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** A single non-streaming request on the model's native API, the same four shapes the engines use. */
export async function complete(model: ModelInfo, system: string, user: string, maxTokens = 4000): Promise<Reply> {
  const key = config.saygm.apiKey;
  if (!key) throw new Error("SAYGM_API_KEY is not set");
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`SayGM ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as any;
  };
  const bearer = { authorization: `Bearer ${key}` };
  switch (model.api) {
    case "anthropic": {
      const auth = config.saygm.anthropicAuth === "bearer" ? bearer : { "x-api-key": key };
      const j = await post(`${config.saygm.anthropicBaseUrl}/v1/messages`, { ...auth, "anthropic-version": "2023-06-01" }, {
        model: model.id,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      });
      const text = (j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    }
    case "google": {
      const j = await post(`${config.saygm.anthropicBaseUrl}/v1beta/models/${encodeURIComponent(model.id)}:generateContent`, { "x-goog-api-key": key }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" },
      });
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      return { text, inputTokens: j.usageMetadata?.promptTokenCount ?? 0, outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0 };
    }
    case "responses": {
      const j = await post(`${config.saygm.openaiBaseUrl}/responses`, bearer, { model: model.id, instructions: system, input: user, max_output_tokens: maxTokens });
      const text =
        typeof j.output_text === "string"
          ? j.output_text
          : (j.output ?? []).flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text).join("");
      return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
    }
    default: {
      const j = await post(`${config.saygm.openaiBaseUrl}/chat/completions`, bearer, {
        model: model.id,
        max_completion_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      return { text: j.choices?.[0]?.message?.content ?? "", inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
    }
  }
}

/* ---------------- putting it together ---------------- */

export function advisorModels() {
  return { advisor: config.agent.advisorModel, strong: config.agent.advisorStrongModel };
}

export async function advise(task: string, strong = false): Promise<Advice> {
  task = task.replace(/\s+/g, " ").trim();
  if (task.length < 3) throw new Error("Describe the task first");
  if (task.length > 2000) task = task.slice(0, 2000);
  const models = await listModels();
  const want = strong ? config.agent.advisorStrongModel : config.agent.advisorModel;
  const advisor = models.find((m) => m.id === want);
  if (!advisor) throw new Error(`The advisor model ${want} isn't in SayGM's catalogue (Settings → Configuration → ${strong ? "Stronger advisor" : "Advisor model"})`);

  const usageList = usageByModel();
  const usage = new Map(usageList.map((u) => [u.id, u]));
  const needs = needsOf(task);
  const short = shortlist(models, needs, usage);
  if (!short.length) throw new Error(needs.vision ? "No model in the catalogue has both tools and vision" : "No models with prices in the catalogue");
  const allowed = new Map(short.map((m) => [m.id, m]));

  // a typical turn's input from your own history (median of per-model averages), else a fair guess
  const ins = usageList.map((u) => u.avgInputTokens).filter((n): n is number => !!n).sort((a, b) => a - b);
  const typicalIn = ins.length ? ins[Math.floor(ins.length / 2)] : 25_000;

  const { system, user } = prompt(task, short.map((m) => tableRow(m, usage.get(m.id))), typicalIn);
  const reply = await complete(advisor, system, user);
  const { picks, estimate } = parseAdvice(reply.text, allowed);

  const withCost: Pick[] = picks.map((p) => {
    const m = allowed.get(p.id)!;
    const est = m.price ? (estimate.inputTokens * m.price.input + estimate.outputTokens * m.price.output) / 1e6 : undefined;
    return { ...p, estCostUsd: est, usage: usage.get(p.id) };
  });
  const costUsd = await estimateCost(advisor.id, reply.inputTokens, reply.outputTokens);
  record({
    level: "info",
    source: "saygm",
    message: `Model advice from ${advisor.id} (${short.length} models considered): ${withCost.map((p) => `${p.role} ${p.id}`).join(", ")}${costUsd ? ` · $${costUsd.toFixed(4)}` : ""}`,
  });
  return { task, advisor: advisor.id, picks: withCost, estimate, needs, costUsd, considered: short.length };
}
