/**
 * "Is it BitBull or the gateway?" A model that won't answer through an engine is asked the
 * smallest possible question directly: two plain requests to SayGM with BitBull's own key, no
 * agent SDK, no tools, no system prompt. One goes to the Anthropic-style endpoint (what the Claude
 * Agent SDK engine uses, and OpenCode for Claude models), one to the OpenAI-style endpoint (what
 * OpenCode uses for everything else). What comes back says where the fault is.
 *
 * Costs a few tokens. The key is never part of the result; the gateway's message is redacted
 * like anything else shown.
 */
import { redact } from "./activity.js";
import { config } from "./config.js";
import { errText } from "./models.js";
import { routerModelId } from "./router.js";

export interface ProbeLeg {
  door: "anthropic" | "openai";
  /** where it was sent, without the key */
  url: string;
  status: number | null;
  ok: boolean;
  ms: number;
  /** the gateway's own words when it refused, or the network error */
  message?: string;
  retryAfter?: string;
}
export interface ProbeResult {
  model: string;
  legs: ProbeLeg[];
  verdict: string;
  /** whose problem it is, as far as two plain requests can tell */
  side: "gateway" | "bitbull" | "key" | "network" | "unclear";
}

type Fetch = typeof fetch;

async function leg(door: ProbeLeg["door"], url: string, headers: Record<string, string>, body: unknown, f: Fetch): Promise<ProbeLeg> {
  const t0 = Date.now();
  try {
    const res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
    const text = (await res.text().catch(() => "")).slice(0, 2000);
    let message: string | undefined;
    if (!res.ok) {
      message = text;
      try {
        const j = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string };
        const e = typeof j.error === "string" ? j.error : [j.error?.type, j.error?.message].filter(Boolean).join(": ");
        message = e || j.message || text;
      } catch {
        /* not JSON: show what it sent */
      }
      message = redact(message.replace(/\s+/g, " ").trim()).slice(0, 300) || undefined;
    }
    return { door, url, status: res.status, ok: res.ok, ms: Date.now() - t0, message, retryAfter: res.headers.get("retry-after") ?? undefined };
  } catch (e) {
    return { door, url, status: null, ok: false, ms: Date.now() - t0, message: redact(errText(e)).slice(0, 300) };
  }
}

/** What the two answers mean, in a sentence the owner can act on. */
export function verdictOf(a: ProbeLeg, o: ProbeLeg): Pick<ProbeResult, "verdict" | "side"> {
  const denied = (l: ProbeLeg) => l.status === 401 || l.status === 403;
  const busy = (l: ProbeLeg) => l.status === 429 || l.status === 503 || l.status === 529;
  if (a.status === null && o.status === null) return { side: "network", verdict: "Neither request reached SayGM from BitBull's server, so this is the network (the sandbox's allowlist, or SayGM is down), not the model." };
  if (a.ok && o.ok) return { side: "bitbull", verdict: "SayGM answered on this model both ways with BitBull's key. The failure is in how the engine made its request, which is BitBull's to fix: send this result with the failed reply (Copy for agent → full)." };
  if (denied(a) && denied(o)) return { side: "key", verdict: "SayGM turned BitBull's key away on both endpoints. Check the key under Settings → Integrations → SayGM." };
  if (busy(a) && busy(o)) return { side: "gateway", verdict: "SayGM is refusing this model for your key right now, on a plain request with no engine involved. That is on SayGM's side (the model, or a limit on your account), not BitBull. Try again later or pick another model." };
  if (busy(a) && o.ok) return { side: "gateway", verdict: "SayGM serves this model on its OpenAI-style endpoint but is refusing it on its Anthropic-style one, which is what the Claude Agent SDK engine uses. Not BitBull: switch this chat to the OpenCode engine for now, or try again later." };
  if (a.ok && busy(o)) return { side: "gateway", verdict: "SayGM serves this model on its Anthropic-style endpoint but is refusing it on its OpenAI-style one. Not BitBull: try again later." };
  if (denied(a) && o.ok)
    return { side: "key", verdict: `SayGM accepts BitBull's key on its OpenAI-style endpoint but not on its Anthropic-style one, sent as ${config.saygm.anthropicAuth === "bearer" ? "a Bearer token" : "x-api-key"}. The Claude Agent SDK engine can't sign in this way: set SAYGM_ANTHROPIC_AUTH to ${config.saygm.anthropicAuth === "bearer" ? "api-key" : "bearer"} (Settings → Configuration) and try again.` };
  if (a.ok && !o.ok) return { side: "unclear", verdict: "The Anthropic-style endpoint answered and the OpenAI-style one did not. Engines that use the first should work; what the second said is below." };
  if (!a.ok && o.ok) return { side: "unclear", verdict: "The OpenAI-style endpoint answered and the Anthropic-style one did not (see what it said below). The OpenCode engine should work on this model; the Claude Agent SDK engine won't until that is cleared." };
  return { side: "unclear", verdict: "Neither plain request was answered. What SayGM said to each is below; with no engine involved, this is not something BitBull's agent code caused." };
}

export async function probeModel(model: string, f: Fetch = fetch): Promise<ProbeResult | { error: string }> {
  const id = model.trim();
  if (!id || id.length > 200) return { error: "Choose a model." };
  if (routerModelId(id) !== null) return { error: "This check talks to SayGM. For a Ditto Router model, see Settings → Integrations → Ditto." };
  const key = config.saygm.apiKey;
  if (!key) return { error: "No SayGM key is set, so there is nothing to check with." };
  const messages = [{ role: "user", content: "Reply with OK." }];
  const aUrl = `${config.saygm.anthropicBaseUrl}/v1/messages`;
  const oUrl = `${config.saygm.openaiBaseUrl}/chat/completions`;
  const [a, o] = await Promise.all([
    leg("anthropic", aUrl, { "anthropic-version": "2023-06-01", ...(config.saygm.anthropicAuth === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }) }, { model: id, max_tokens: 16, messages }, f),
    leg("openai", oUrl, { authorization: `Bearer ${key}` }, { model: id, max_tokens: 16, messages }, f),
  ]);
  return { model: id, legs: [a, o], ...verdictOf(a, o) };
}
