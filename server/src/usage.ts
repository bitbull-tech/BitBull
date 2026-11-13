/**
 * Spending, per day and per model, from BitBull's own records: every reply stores its usage
 * and an estimated cost from the gateway's live prices (models.ts estimateCost). It is an
 * estimate: SayGM's own usage page is the bill. The SayGM balance itself needs SayGM's
 * account API (Sign in with SayGM), so it isn't here yet.
 */
import { db } from "./db.js";

export interface UsageReport {
  days: number;
  from: string;
  to: string;
  total: { cost: number; replies: number; inputTokens: number; outputTokens: number };
  /** one row per day in the range, oldest first, including days with nothing */
  byDay: Array<{ date: string; cost: number; replies: number; byModel: Record<string, number> }>;
  /** most expensive first */
  byModel: Array<{ model: string; cost: number; replies: number; inputTokens: number; outputTokens: number }>;
  /** replies whose cost couldn't be priced (model not on a price list) */
  unpriced: number;
}

/**
 * The last `days` days, with days cut at the owner's local midnight (`offsetMinutes` east of
 * UTC, as the browser reports it). A fixed offset: around a DST change a few replies can land
 * in the neighbouring day, which an estimate can live with.
 */
export function usageReport(days = 30, offsetMinutes = 0, now = Date.now()): UsageReport {
  const d = Math.min(366, Math.max(1, Math.floor(days)));
  const off = Math.max(-14 * 60, Math.min(14 * 60, Math.round(offsetMinutes)));
  const day = (ms: number) => new Date(ms + off * 60_000).toISOString().slice(0, 10);
  const today = day(now);
  const first = new Date(Date.parse(`${today}T00:00:00Z`) - (d - 1) * 86_400_000).toISOString().slice(0, 10);
  const since = Date.parse(`${first}T00:00:00Z`) - off * 60_000;

  const rows = db
    .prepare(
      `SELECT date((created_at / 1000) + ? * 60, 'unixepoch') AS date,
              model,
              COUNT(*) AS replies,
              SUM(COALESCE(json_extract(usage_json, '$.costUsd'), 0)) AS cost,
              SUM(json_extract(usage_json, '$.costUsd') IS NULL) AS unpriced,
              SUM(COALESCE(json_extract(usage_json, '$.inputTokens'), 0)) AS input_tokens,
              SUM(COALESCE(json_extract(usage_json, '$.outputTokens'), 0)) AS output_tokens
         FROM messages
        WHERE role = 'assistant' AND model IS NOT NULL AND created_at >= ?
          AND usage_json IS NOT NULL AND json_valid(usage_json)
        GROUP BY date, model`,
    )
    .all(off, since) as Array<{ date: string; model: string; replies: number; cost: number; unpriced: number; input_tokens: number; output_tokens: number }>;

  const byDay = new Map<string, UsageReport["byDay"][number]>();
  for (let i = 0; i < d; i++) {
    const date = new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(date, { date, cost: 0, replies: 0, byModel: {} });
  }
  const byModel = new Map<string, UsageReport["byModel"][number]>();
  const total = { cost: 0, replies: 0, inputTokens: 0, outputTokens: 0 };
  let unpriced = 0;
  for (const r of rows) {
    const bucket = byDay.get(r.date);
    if (!bucket) continue;
    bucket.cost += r.cost;
    bucket.replies += r.replies;
    bucket.byModel[r.model] = (bucket.byModel[r.model] ?? 0) + r.cost;
    const m = byModel.get(r.model) ?? { model: r.model, cost: 0, replies: 0, inputTokens: 0, outputTokens: 0 };
    m.cost += r.cost;
    m.replies += r.replies;
    m.inputTokens += r.input_tokens;
    m.outputTokens += r.output_tokens;
    byModel.set(r.model, m);
    total.cost += r.cost;
    total.replies += r.replies;
    total.inputTokens += r.input_tokens;
    total.outputTokens += r.output_tokens;
    unpriced += r.unpriced;
  }
  return {
    days: d,
    from: first,
    to: today,
    total,
    byDay: [...byDay.values()],
    byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost || b.replies - a.replies),
    unpriced,
  };
}
