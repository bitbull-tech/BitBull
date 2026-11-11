# Threat Model — BitBull

Who and what BitBull defends against, where the walls are, and — just as important —
where they are not. Read this before self-hosting, forking, or reporting an issue.

## Scope and actors

BitBull is a **single-owner, self-hosted** personal agent. It is not multi-tenant and makes
no claims about isolating users from each other. The actors we design against:

1. **A malicious repository** the agent is asked to clone or review (hostile `.git/config`,
   planted files, prompt-injecting content).
2. **A compromised model reply / prompt injection** driving the agent's tools.
3. **A hostile upload or linked folder** (traversal, symlinks, secret-laden content).
4. **The agent itself after injection**, trying to read secrets, escape the sandbox,
   exfiltrate, or approve its own network access.
5. **An outside contributor** (poisoned PR: code, workflows, dependencies, filenames).
6. **Another process on the owner's PC** (localhost callers of the API and link helper).

## Assets

| Asset | Where it lives | Primary protection |
|---|---|---|
| Service keys (SayGM, Ditto, GitHub, Atlas, 404, Hippius, Taostats) | `.env`, vault, server memory | env stripping, guard redaction, vault (at rest) |
| `APP_TOKEN` (the API's one credential) | server env | loopback-only gateway, timing-safe compare |
| Vault key (decrypts all vaulted keys) | Windows helper (DPAPI), server memory while unlocked | never on Linux disk |
| Chats, uploads, memory archive | `/data` (SQLite, files), Ditto account | container walls, redaction on archive |
| Linked folders (your files, documents) | Windows, mounted `ro,noexec` into the sandbox | 4-layer read-only enforcement + write-test |
| The owner's PC and home network | — | internal Docker network, `private_dst` squid rule, loopback binds |
| The WSL distro root | — | scripts run unprivileged where possible |

## Trust boundaries

1. **Browser ↔ gateway** (`127.0.0.1:8787`): bearer `APP_TOKEN`; query-token only on the two
   SSE streams; `/api/health` and `/api/brand*` are intentionally public.
2. **Agent container ↔ everything**: internal Docker network (no internet, no LAN, no host
   route); all web traffic via the squid allowlist proxy; `cap_drop ALL`, read-only rootfs,
   non-root, tmpfs `/tmp`.
3. **Egress proxy ↔ internet**: static allowlist plus *in-memory* user approvals; private/IP
   destinations denied before any allow rule; approvals decided only by the user.
4. **Server ↔ engines**: engine children get a scrubbed env; the OpenCode plugin redacts
   known key values from tool output; read-only subagents get no shell and no delegation.
5. **Server ↔ Windows link helper** (`localhost:8790`): only BitBull's page (Origin-checked);
   link/unlink need the owner in a Windows dialog; the helper never accepts a path from the page.
6. **Workspaces ↔ linked folders**: links are `ro,noexec,nosuid,nodev`, re-verified at runtime;
   folders with secrets are linked only as filtered copies.

## What IS defended (verified in the pre-release audit)

- **Auth plumbing**: timing-safe token compare; empty token never authenticates; MCP and
  `/internal` endpoints on separate startup tokens; egress-check endpoint answers only the
  proxy container's IP.
- **Uploads**: lexical sanitisation **plus** realpath containment and symlink refusal; body
  size capped before parsing; `.claude`/`.opencode` refused at the root.
- **Linked folders**: enforced read-only at four independent layers (drvfs flags, bind
  remount, compose `:ro`, server mount-flag check) with a runtime write-test failsafe.
- **Settings**: the UI can only change `EDITABLE` keys — never access, sandbox, proxy or
  path settings; unknown keys planted in the agent-writable `settings.local.json` are
  ignored and reported; the file is written `0600`.
- **Vault (at rest)**: AES-256-GCM, fresh IV per write, wrong key fails authentication,
  atomic `0600` writes, values held in memory only. It protects keys **at rest from a file
  read** — it does not make them invisible to a running agent (see R1). This is a real
  improvement over plaintext `settings.local.json` — **as at-rest protection**.
- **Storage mirror**: AES-256-GCM wire format with tag-at-end and plaintext SHA-256.
- **Egress**: host normalisation (userinfo, IPs, trailing dots, IDN edge cases), suffix
  matching on dot boundaries, fail-closed helper, metadata/RFC-1918 blocked even for
  approved names.
- **Database**: parameterised statements throughout, transactions for multi-writes.
- **Image supply**: `.dockerignore` keeps all secret material out of the build context.
- **Read-only subagents**: no shell, no edit tools, no delegation — enforced, tested.

## What is NOT defended — known residual risks

These are the honest limits. Most stem from one root cause.

### R1 — Shared uid between server and agent (root cause)
The server, the engines and the agent's shell all run as **uid 1000 in one container**.
A determined agent can therefore:
- read `/proc/<server>/environ` → `APP_TOKEN`, and with it self-approve egress domains,
  read chats, change UI settings (`docs/GAPS.md` #11);
- read `/proc/<engine>/environ` → engine env, including **vault values while the vault is
  unlocked** and the Ditto key inside `ditto_review`'s CLI process;
- read `/proc/<server>/mem` (dumpable by default) → vault key and decrypted values;
- write `agent.db`, `settings.local.json`, `vault.json` (same uid: the database is
  **advisory only**; nothing security-critical may trust it).

**Consequence: the egress proxy and the vault are governance/accident controls, not
exfiltration barriers.** The planned fix is a separate per-project tool container with no
secrets (GAPS #11). Until then, everything below should be read with this in mind.

### R2 — Claude engine hands the SayGM key to the shell
`ANTHROPIC_API_KEY` is set for the Claude SDK and inherited by every shell it spawns; the
bitbull-guard plugin exists only for OpenCode. Prefer the OpenCode engine for untrusted work. On a Ditto Router model the same
goes for the Router endpoint key (`ANTHROPIC_AUTH_TOKEN`): it reaches the endpoint's tools on
`.heyditto.ai`, the same tools the turn already has, behind Ditto's approval gate. Plan turns carry
the review endpoint's key instead, which reaches no tools and no memory (docs/ROUTER.md).

### R3 — Redaction is exact-substring only
Server `redact()` and bitbull-guard match configured values verbatim. Base64, case changes,
splitting across tool calls, or using a key without printing it (e.g. `curl -H "…$(cat)"`)
all evade it. Redaction prevents **accidental echo**, never exfiltration. GitHub and SayGM
hosts are on the allowlist by design — they are standing exfil channels for any key the
agent can reach.

### R4 — DNS exfiltration (checked 5 Nov 2026 — contained, but by topology)
**Not exploitable as built.** In `bitbull-agent`, `getent hosts example.com` and
`getent hosts github.com` both fail while `curl https://github.com` succeeds: the container
has no name resolution of its own and reaches the network only through squid, so there is no
unproxied, unlogged channel out.

Note *why*, because it matters. The container is not configured without DNS — its
`/etc/resolv.conf` names Docker's embedded resolver at `127.0.0.11`, forwarding to the host
at `10.255.255.254`. That forward simply cannot be reached from an `internal` network. The
containment is a side effect of the compose topology, not a DNS policy anyone declared, and
nothing in the code would notice it changing. Attaching the agent to a routable network —
for convenience, or when the GAPS #11 tool container arrives — silently restores DNS
resolution and with it a tunnelling channel squid never sees.

Guarded by `scripts\bitbull-wsl\test-stack.ps1 -Check`, which asserts both halves (no
resolution, yet HTTPS through the proxy) against a running stack. Run it after any change to
`docker-compose.yml`'s networks.

### R5 — Domain fronting (structural)
Squid checks the CONNECT hostname, then the tunnel is opaque. CDN-fronted allowlist entries
(some GitHub hosts) may permit TLS to a different tenant of the same CDN. Price of
name-based allowlisting; no cheap fix.

### R6 — Localhost is trusted on the owner's PC
The API gateway and the link helper bind loopback. Any local process can call the helper
with a forged `Origin` header, and can hammer the API token (no rate limiting) — on a
multi-user PC this means *other users' processes too*. Deliberate, but see the pre-release
fix list for the `/vault-key` endpoint.

### R7 — Approvals and guard rails are memory-only
Egress approvals die with the server (deliberate, because `/data` is agent-writable). The
agent can re-request after every restart — the audit trail is the activity feed. Watch it.

### R8 — `GITHUB_TOKEN` / `TAOSTATS_API_KEY` are given to the agent on purpose
They are needed for git operations and the taostats skill. Vaulting them is at-rest
protection only; at runtime the agent can use them. Use a fine-grained, repo-scoped PAT.

### R9 — Host mode (`npm run dev`) has no sandbox
On the host there is no container, no proxy, and the shell is off only by configuration.
Every residual above applies directly to the owner's user account. Development only.

## If you fork or change `.env` / `allowlist.txt`

- `ALLOW_NO_AUTH=true` removes **all** authentication — combine it with a tunnel or a
  published port and your agent, keys and Ditto memory are open to anyone who finds it.
- A weak `APP_TOKEN` can be brute-forced from anything on your PC (no rate limiting).
- A classic `ghp_` token with broad scope lets an injected agent push to **all** your repos.
- A personal Ditto key with `DITTO_ARCHIVE=turn` archives *everything you type* into a
  memory every connected agent can search. Use a dedicated key for BitBull's own Ditto agent.
- Broadening `allowlist.txt` opens unlogged egress; `private_dst` still protects your LAN.

## Pre-release audit (2026-11, four reviewers + handler)

Full findings were triaged into the fix list below. P0 = gate the open-source release.

**P0 — release blockers.** Status after the security branch was merged into main
(`8221226`, 5 Nov 2026): 1, 4 and 6 were fixed first (`084467c`, with regression tests);
2, 5, 7, 9–12 landed with the merge. **8 no longer applies** — the file it concerned has
been deleted. **3 is the only one still open.** The items below keep their original
numbering; "this branch" means the security branch, now merged.

1. ~~`repos.ts`: git executed repo-local config~~ — **FIXED on main**: scrubbed env, `-c`
   overrides, and a refusal when the repo's own config defines any exec-capable key (covers
   `filter.*.clean`/textconv drivers too). Regression: `repos-hostile.test.ts`.
2. `link-helper.ps1` `/vault-key`: any local process with a forged Origin gets the vault
   key — gate it behind a Windows consent dialog or a paired helper token. (This branch:
   consent dialog.)
3. `desktop/src-tauri`: app commands are invocable from the BitBull webview (default-allow)
   — reject non-`main` webview labels in each command. **Status: prove it first** — the fix
   compiles (`cargo check` clean) but needs a runtime proof (invoke from the BitBull window's
   devtools, pre-fix and post-fix) before it ships. **Still open as of 5 Nov 2026** — no
   label guard is present in `lib.rs`; the webview-scoped capability in
   `capabilities/default.json` (`"windows": ["main"]`) is the only control, and the whole
   finding may be a false positive, which is what the proof would settle.
4. ~~`mcp.ts` `ditto_review`~~ — **FIXED on main**: dedicated HOME, `GIT_CONFIG_NOSYSTEM`/
   `GLOBAL`. This branch adds `GIT_CONFIG_PARAMETERS` so the reviewed repo's *own* config
   can't name exec drivers either. Residuals: `DITTO_CONFIG_DIR` still points into
   agent-writable `/data`, and the key remains in the child's env (`/proc`, R1); full
   isolation waits for the tool container.
5. Vault values reach the OpenCode process environment on unlock — scrub env around the
   engine spawn; document the vault as at-rest protection (see R1). (This branch.)
6. ~~Egress "allow whole domain" is public-suffix-blind~~ — **FIXED on main**: under a
   shared suffix the approvable "domain" is the suffix plus one label (one site). This
   branch adds the complement: a *bare* suffix (`github.io`, `co.uk`) can never be
   domain-approved.
7. Host mode binds `0.0.0.0` by default and suggests `ALLOW_NO_AUTH=true` — default to
   loopback and refuse/warn loudly on non-loopback no-auth.
8. ~~The old-distro migration script: root tar restore follows planted symlinks~~ — **REMOVED, not
   fixed** (`a5fdeb5`): the script was a one-off for migrating off a retired earlier distro
   and is deleted. The unprivileged restore it would have needed could not chown to the
   userns-remapped uid anyway, so there was no fix worth keeping the file for. Any future
   restore path must reject link members in the tar.
9. `deploy.ps1`: top-level filenames interpolated unquoted into a `.cmd` line — quote and
   validate (hostile-contributor filename → command execution at deploy).
10. `storage.ts` restore: decrypt-to-temp, verify tag+sha256, then rename; `verified` must
    require a stored hash; `mirrorFile` must enforce `insideWorkspace`.
11. CI: add `permissions: contents: read`, SHA-pin actions; `npm audit fix` (server:
    body-parser high + 3 moderate; web clean).
12. `swarm.ts`: reviewers run with full tools on hostile repos and their raw output is
    interpolated into the verdict prompt; the verdict turn can be silently dropped —
    scope reviewers read-only, fence report text, wait out a busy chat. Residual after the
    fix: plan mode fenced filesystem and shell only — reviewers still held MCP tools
    (`save_memory`, `request_network_access`). **Closed 7 Nov 2026** after both reviewers in the
    second swarm reached it independently: plan mode now attaches no MCP servers on the Claude
    engine and switches every `ditto_*`, `bitbull_*` and integration tool off per prompt on
    OpenCode, so a hostile target can no longer write to long-term memory or word a network
    consent card.

**P1 — fast follow**: brand-asset realpath check; `repos/diff` symlink containment;
`ditto.ts` archiving the user prompt verbatim; guard redaction floor alignment (8 vs 7
chars) and config-key walker coverage; `GET /api/vault` side effects; import-route
transaction; squid IPv4-mapped range; gateway/proxy off the `outside` network; helper
`/status` Origin check; dialog text sanitisation; `$Distro`/`-User` validation in scripts;
copy-in destination symlink check.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Please do **not** open public issues for
vulnerabilities, and never include real secrets in a report.
