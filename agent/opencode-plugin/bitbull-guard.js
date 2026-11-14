/**
 * BitBull guard — an OpenCode plugin loaded by BitBull.
 *
 * 1. shell.env: blanks BitBull's own credentials in every shell the agent starts, so `env`,
 *    `printenv` or a crash dump can't print them. (Keys meant for the agent, like
 *    GITHUB_TOKEN for git, stay.)
 * 2. tool.execute.after: replaces any known secret value in tool output with [REDACTED]
 *    before the model (and the chat history) ever sees it — however the value was obtained.
 *
 * This stops accidental leaks. It is not a hard wall: the shell runs as the same user as
 * BitBull, so a determined agent could still find keys on disk. Separating the tool runner from
 * the server is the real fix (docs/GAPS.md item 11).
 */

// Credentials the agent's shell never needs
const HIDE = [
  "SAYGM_API_KEY", "DITTO_API_KEY", "DITTO_ROUTER_KEY", "DITTO_ROUTER_REVIEW_KEY", "APP_TOKEN", "ATLAS_API_KEY", "TELEGRAM_BOT_TOKEN", "LEADPOET_OAUTH",
  "HIPPIUS_ACCESS_KEY", "HIPPIUS_SECRET_KEY", "HIPPIUS_ENCRYPTION_KEY",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD",
];
// Given to the agent on purpose, but their values still shouldn't be echoed to the model
const MASK_ONLY = ["GITHUB_TOKEN", "GH_TOKEN", "TAOSTATS_API_KEY", "FOUR04_MODEL_KEY"];

function secretValues() {
  const vals = new Set();
  for (const k of [...HIDE, ...MASK_ONLY]) {
    const v = process.env[k];
    if (v && v.length >= 8 && k !== "OPENCODE_CONFIG_CONTENT") vals.add(v);
  }
  // keys embedded in OpenCode's own config (provider apiKeys, MCP auth headers)
  try {
    const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}");
    const walk = (o, key) => {
      if (typeof o === "string") {
        if (/^(apiKey|authorization|x-api-key|x-goog-api-key)$/i.test(key || "")) {
          const v = o.replace(/^Bearer\s+/i, "");
          if (v.length >= 8) vals.add(v);
        }
      } else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, k);
    };
    walk(cfg);
  } catch {}
  // longest first so a key that contains another is replaced whole
  return [...vals].sort((a, b) => b.length - a.length);
}

export const BitBullGuard = async () => {
  const secrets = secretValues();
  const redact = (s) => (typeof s === "string" ? secrets.reduce((acc, v) => acc.split(v).join("[REDACTED]"), s) : s);
  const scrub = (o, depth = 0) => {
    if (!o || typeof o !== "object" || depth > 4) return;
    for (const k of Object.keys(o)) {
      if (typeof o[k] === "string") o[k] = redact(o[k]);
      else scrub(o[k], depth + 1);
    }
  };
  return {
    "shell.env": async (_input, output) => {
      for (const k of HIDE) output.env[k] = "";
    },
    "tool.execute.after": async (_input, output) => {
      if (typeof output.output === "string") output.output = redact(output.output);
      if (typeof output.title === "string") output.title = redact(output.title);
      scrub(output.metadata);
    },
  };
};
