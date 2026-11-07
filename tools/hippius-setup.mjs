#!/usr/bin/env node
/**
 * Create the Hippius bucket and a scoped sub-token for BitBull, and (optionally) write the
 * credentials straight into BitBull's settings so the secret never has to be copied by hand.
 *
 *   HIPPIUS_CONSOLE_TOKEN=... node tools/hippius-setup.mjs
 *   HIPPIUS_CONSOLE_TOKEN=... BITBULL_APP_TOKEN=... node tools/hippius-setup.mjs --save
 *
 * The console token comes from the Hippius Console -> Settings (an account access token,
 * used with `Authorization: Token ...`). It is only used here, never stored, and never sent
 * anywhere except api.hippius.com.
 *
 * Lost the secret for a key you already have? There is no way to read it back - Hippius
 * shows it once at creation and `/objectstore/tokens/auth/` is validator-only. Either make
 * a new sub-token (just run this with no flags) or rotate the old one:
 *
 *   node tools/hippius-setup.mjs --doctor            # what exists, and what to do about it
 *   node tools/hippius-setup.mjs --rotate <id>       # new secret for an existing key
 *
 * Options
 *   --doctor            list everything and say what to do next
 *   --list              list master tokens, sub-tokens and buckets
 *   --rotate <id|key>   mint a new secret for an existing token (revokes the old one)
 *   --bucket <name>     bucket to use or create        (default: bitbull-agent, or HIPPIUS_BUCKET)
 *   --prefix <p>        limit the sub-token to one key prefix, repeatable (e.g. --prefix general/)
 *   --actions <a,b>     sub-token actions              (default: read,write)
 *   --name <n>          sub-token name                 (default: bitbull-agent)
 *   --expires <iso>     expiry, e.g. 2027-01-01T00:00:00Z (default: no expiry)
 *   --save              write the credentials into BitBull instead of printing the secret
 *   --bitbull <url>          BitBull base URL                    (default: http://localhost:8787, or BITBULL_URL)
 *   --list              show existing buckets and sub-tokens, change nothing
 *
 * Docs: https://api.hippius.com/ (Swagger), docs/STORAGE.md
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

const bucket = one("bucket", process.env.HIPPIUS_BUCKET ?? "bitbull-agent");
const bitbullUrl = (one("bitbull", process.env.BITBULL_URL ?? "http://localhost:8787")).replace(/\/$/, "");

if (!TOKEN) {
  console.error("Set HIPPIUS_CONSOLE_TOKEN first (Hippius Console -> Settings -> access token).");
  console.error("  PowerShell:  $env:HIPPIUS_CONSOLE_TOKEN = 'hpc_...'");
  console.error("  bash:        export HIPPIUS_CONSOLE_TOKEN=hpc_...");
  process.exit(1);
}

/** Hippius blocks some default user agents with 403 / error code 1010, so send our own. */
async function hippius(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Token ${TOKEN}`,
      "user-agent": "bitbull-agent-setup/1.0",
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
    const hint =
      res.status === 401
        ? "\n\nThat token was not accepted. HIPPIUS_CONSOLE_TOKEN must be the ACCOUNT access token\nfrom the Hippius Console under Settings - not an S3 access key, which is a different thing\nand is only used by S3 clients."
        : res.status === 403
          ? "\n\nAuthenticated but not allowed. Check the token belongs to the account that owns the bucket."
          : "";
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}\n${detail}${hint}`);
  }
  return body;
}

const asList = (r) =>
  Array.isArray(r) ? r : (r?.results ?? r?.buckets ?? r?.sub_tokens ?? r?.master_tokens ?? r?.tokens ?? []);
const idOf = (t) => t.id ?? t.token_id ?? t.tokenId ?? "";
const keyOf = (t) => t.accessKeyId ?? t.access_key_id ?? "";
const describe = (t) =>
  `${(t.name ?? "(unnamed)").padEnd(18)} ${keyOf(t).padEnd(26)} ${(t.status ?? "").padEnd(8)} ${(t.bucketNames ?? t.bucket_names ?? []).join(",")}`;

/** Everything the account has, so you can see what you're working with. */
async function inventory() {
  const out = {};
  for (const [key, path] of [
    ["masters", "/objectstore/master-tokens/"],
    ["subs", "/objectstore/sub-tokens/"],
    ["buckets", "/objectstore/buckets/"],
  ]) {
    try {
      out[key] = asList(await hippius(path));
    } catch (e) {
      out[key] = { error: e.message };
    }
  }
  return out;
}

async function main() {
  if (flag("whoami") || flag("doctor") || flag("list")) {
    let who = null;
    try {
      who = await hippius("/users/me/");
    } catch {
      /* some accounts can't read this; the inventory below is the real test */
    }
    if (who) console.log(`Signed in as ${who.username ?? who.email ?? who.id ?? "(unknown)"}`);
    const inv = await inventory();

    const section = (title, rows) => {
      if (rows?.error) return console.log(`\n${title}: could not read (${rows.error.split("\n")[0]})`);
      console.log(`\n${title} (${rows.length}):`);
      for (const r of rows) console.log("  " + (typeof r === "string" ? r : describe(r)));
      if (!rows.length) console.log("  (none)");
    };
    section("Master tokens", inv.masters);
    section("Sub-tokens", inv.subs);
    section(
      "Buckets",
      Array.isArray(inv.buckets) ? inv.buckets.map((b) => b.name ?? b.Name ?? JSON.stringify(b)) : inv.buckets,
    );

    // Nothing readable means the token is wrong, not that the account is empty - saying
    // "no bucket yet" here would send you off creating things you may already have.
    const unreadable = [inv.masters, inv.subs, inv.buckets].filter((r) => r?.error);
    if (unreadable.length === 3) {
      console.log(`\n${unreadable[0].error}`);
      process.exitCode = 1;
      return;
    }

    if (flag("doctor")) {
      console.log("\n--- what to do next ---");
      const bucketNames = Array.isArray(inv.buckets) ? inv.buckets.map((b) => b.name ?? b.Name) : [];
      if (!bucketNames.length) console.log(`- No bucket yet. Run without flags to create "${bucket}" and a sub-token for it.`);
      else if (!bucketNames.includes(bucket)) console.log(`- You have ${bucketNames.join(", ")}. Use --bucket <name> to pick one, or run without flags to create "${bucket}".`);
      else console.log(`- Bucket "${bucket}" exists.`);

      const active = (Array.isArray(inv.subs) ? inv.subs : []).filter((t) => (t.status ?? "active") === "active");
      if (!active.length) console.log("- No active sub-token. Run without flags to create one (you get the secret once, there and then).");
      else {
        console.log(`- You have ${active.length} active sub-token(s). A secret is only ever shown at creation, so if you don't have it:`);
        for (const t of active) console.log(`    node tools/hippius-setup.mjs --rotate ${idOf(t)}      # ${t.name ?? "(unnamed)"} ${keyOf(t)}`);
        console.log("  Rotating mints a new secret and revokes the old one. Anything still using the old secret stops working.");
      }
      console.log("- Then add --save (with BITBULL_APP_TOKEN set) to write the credentials straight into BitBull.");
    }
    return;
  }

  // Lost the secret for a token you already have: mint a new one.
  const rotate = one("rotate", "");
  if (rotate) {
    const inv = await inventory();
    const all = [...(Array.isArray(inv.subs) ? inv.subs : []), ...(Array.isArray(inv.masters) ? inv.masters : [])];
    const match = all.find((t) => idOf(t) === rotate || keyOf(t) === rotate);
    if (!match) throw new Error(`No token here with id or access key "${rotate}". Run --list to see them.`);
    const isMaster = (Array.isArray(inv.masters) ? inv.masters : []).some((t) => idOf(t) === idOf(match));
    const path = `/objectstore/${isMaster ? "master" : "sub"}-tokens/${idOf(match)}/rotate/`;
    console.log(`Rotating ${isMaster ? "master" : "sub"}-token "${match.name ?? "(unnamed)"}"...`);
    const res = await hippius(path, { method: "POST" });
    await handOver(res, bucket);
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
    name: one("name", "bitbull-agent"),
    scope_type: "single_bucket",
    bucket_names: [bucket],
    actions: one("actions", "read,write").split(",").map((s) => s.trim()).filter(Boolean),
    ...(prefixes.length ? { allowed_prefixes: prefixes } : {}),
    ...(one("expires", "") ? { expires_at: one("expires", "") } : {}),
  };
  const created = await hippius("/objectstore/sub-tokens/", { method: "POST", body: JSON.stringify(payload) });
  console.log(`Created sub-token "${payload.name}" (${payload.actions.join("+")}${prefixes.length ? `, prefixes ${prefixes.join(" ")}` : ""}).`);
  await handOver(created, bucket);
}

/** The one moment the secret exists outside Hippius: into BitBull, or onto the screen. */
async function handOver(created, bucketName) {
  const accessKeyId = created.accessKeyId ?? created.access_key_id;
  const secret = created.secret;
  if (!accessKeyId || !secret) throw new Error(`No credentials in the response:\n${JSON.stringify(created, null, 2)}`);

  if (flag("save")) {
    const appToken = process.env.BITBULL_APP_TOKEN ?? "";
    if (!appToken) throw new Error("--save needs BITBULL_APP_TOKEN (the token you unlock the BitBull UI with)");
    const res = await fetch(`${bitbullUrl}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${appToken}` },
      body: JSON.stringify({ values: { HIPPIUS_ACCESS_KEY: accessKeyId, HIPPIUS_SECRET_KEY: secret, HIPPIUS_BUCKET: bucketName } }),
    });
    if (!res.ok) throw new Error(`BitBull refused the settings (${res.status}): ${(await res.text()).slice(0, 300)}`);
    console.log(`\nSaved into BitBull at ${bitbullUrl}. The secret was never printed.`);
    console.log(`Access key: ${accessKeyId}`);
    console.log("\nStill to do in BitBull, Settings > Configuration > Hippius storage:");
    console.log("  - Encryption key > Generate > copy it somewhere safe > Save");
    console.log("Then Settings > Status should show Hippius storage green.");
  } else {
    console.log("\nPaste these into BitBull, Settings > Configuration > Hippius storage.");
    console.log("The secret is shown once, here, and nowhere else:\n");
    console.log(`  Sub-token access key : ${accessKeyId}`);
    console.log(`  Sub-token secret     : ${secret}`);
    console.log(`  Bucket               : ${bucketName}`);
    console.log("\nThen: Encryption key > Generate > copy it somewhere safe > Save.");
  }
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  if (/actions/i.test(e.message)) console.error("\nThe server rejected the actions list; try --actions with the values it names above.");
  // exitCode rather than exit(): exit() during a pending fetch teardown trips a libuv assert on Windows
  process.exitCode = 1;
});
