#!/usr/bin/env node
/**
 * Create the Hippius bucket and a scoped sub-token for GM, and (optionally) write the
 * credentials straight into GM's settings so the secret never has to be copied by hand.
 *
 *   HIPPIUS_CONSOLE_TOKEN=... node tools/hippius-setup.mjs
 *   HIPPIUS_CONSOLE_TOKEN=... GM_APP_TOKEN=... node tools/hippius-setup.mjs --save
 *
 * The console token comes from the Hippius Console → Settings (an account access token,
 * used with `Authorization: Token …`). It is only used here, never stored, and never sent
 * anywhere except api.hippius.com.
 *
 * Options
 *   --bucket <name>     bucket to use or create        (default: gm-agent, or HIPPIUS_BUCKET)
 *   --prefix <p>        limit the sub-token to one key prefix, repeatable (e.g. --prefix general/)
 *   --actions <a,b>     sub-token actions              (default: read,write)
 *   --name <n>          sub-token name                 (default: gm-agent)
 *   --expires <iso>     expiry, e.g. 2027-01-01T00:00:00Z (default: no expiry)
 *   --save              write the credentials into GM instead of printing the secret
 *   --gm <url>          GM base URL                    (default: http://localhost:8787, or GM_URL)
 *   --list              show existing buckets and sub-tokens, change nothing
 *
 * Docs: https://api.hippius.com/ (Swagger) · docs/STORAGE.md
 */
const API = process.env.HIPPIUS_API ?? "https://api.hippius.com/api";
const TOKEN = process.env.HIPPIUS_CONSOLE_TOKEN ?? "";
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const one = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const many = (n) => args.flatMap((a, i) => (a === `--${n}` && args[i + 1] ? [args[i + 1]] : []));

const bucket = one("bucket", process.env.HIPPIUS_BUCKET ?? "gm-agent");
const gmUrl = (one("gm", process.env.GM_URL ?? "http://localhost:8787")).replace(/\/$/, "");

if (!TOKEN) {
  console.error("Set HIPPIUS_CONSOLE_TOKEN first (Hippius Console → Settings → access token).");
  console.error("  PowerShell:  $env:HIPPIUS_CONSOLE_TOKEN = 'hpc_…'");
  console.error("  bash:        export HIPPIUS_CONSOLE_TOKEN=hpc_…");
  process.exit(1);
}

/** Hippius blocks some default user agents with 403 / error code 1010, so send our own. */
async function hippius(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Token ${TOKEN}`,
      "user-agent": "gm-agent-setup/1.0",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body);
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status}\n${detail}`);
  }
  return body;
}

const asList = (r) => (Array.isArray(r) ? r : (r?.results ?? r?.buckets ?? r?.sub_tokens ?? []));

async function main() {
  if (flag("list")) {
    const buckets = asList(await hippius("/objectstore/buckets/"));
    console.log(`Buckets (${buckets.length}):`);
    for (const b of buckets) console.log(`  ${b.name ?? b.Name ?? JSON.stringify(b)}`);
    const tokens = asList(await hippius("/objectstore/sub-tokens/"));
    console.log(`\nSub-tokens (${tokens.length}):`);
    for (const t of tokens)
      console.log(`  ${t.name ?? "(unnamed)"}  ${t.accessKeyId ?? t.access_key_id ?? ""}  ${t.status ?? ""}  ${(t.bucketNames ?? t.bucket_names ?? []).join(",")}`);
    return;
  }

  // 1. The bucket
  const buckets = asList(await hippius("/objectstore/buckets/"));
  const names = buckets.map((b) => b.name ?? b.Name).filter(Boolean);
  if (names.includes(bucket)) {
    console.log(`Bucket "${bucket}" already exists.`);
  } else {
    await hippius("/objectstore/buckets/", { method: "POST", body: JSON.stringify({ name: bucket }) });
    console.log(`Created bucket "${bucket}".`);
  }

  // 2. The sub-token, scoped to that bucket (and optionally to a key prefix)
  const prefixes = many("prefix");
  const payload = {
    name: one("name", "gm-agent"),
    scope_type: "single_bucket",
    bucket_names: [bucket],
    actions: one("actions", "read,write").split(",").map((s) => s.trim()).filter(Boolean),
    ...(prefixes.length ? { allowed_prefixes: prefixes } : {}),
    ...(one("expires", "") ? { expires_at: one("expires", "") } : {}),
  };
  const created = await hippius("/objectstore/sub-tokens/", { method: "POST", body: JSON.stringify(payload) });
  const accessKeyId = created.accessKeyId ?? created.access_key_id;
  const secret = created.secret;
  if (!accessKeyId || !secret) throw new Error(`Unexpected response:\n${JSON.stringify(created, null, 2)}`);
  console.log(`Created sub-token "${payload.name}" (${payload.actions.join("+")}${prefixes.length ? `, prefixes ${prefixes.join(" ")}` : ""}).`);

  // 3. Hand it to GM, or print it
  if (flag("save")) {
    const appToken = process.env.GM_APP_TOKEN ?? "";
    if (!appToken) throw new Error("--save needs GM_APP_TOKEN (the token you unlock the GM UI with)");
    const res = await fetch(`${gmUrl}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ values: { HIPPIUS_ACCESS_KEY: accessKeyId, HIPPIUS_SECRET_KEY: secret, HIPPIUS_BUCKET: bucket } }),
    });
    if (!res.ok) throw new Error(`GM refused the settings (${res.status}): ${(await res.text()).slice(0, 300)}`);
    console.log(`\nSaved into GM at ${gmUrl}. The secret was never printed.`);
    console.log(`Access key: ${accessKeyId}`);
    console.log("\nStill to do in GM → Settings → Configuration → Hippius storage:");
    console.log("  • Encryption key → Generate → copy it somewhere safe → Save");
    console.log("Then Settings → Status should show Hippius storage green.");
  } else {
    console.log("\nPaste these into GM → Settings → Configuration → Hippius storage.");
    console.log("The secret is shown once, here, and nowhere else:\n");
    console.log(`  Sub-token access key : ${accessKeyId}`);
    console.log(`  Sub-token secret     : ${secret}`);
    console.log(`  Bucket               : ${bucket}`);
    console.log("\nThen: Encryption key → Generate → copy it somewhere safe → Save.");
  }
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  if (/actions/i.test(e.message)) console.error("\nThe server rejected the actions list; try --actions with the values it names above.");
  // exitCode rather than exit(): exit() during a pending fetch teardown trips a libuv assert on Windows
  process.exitCode = 1;
});
