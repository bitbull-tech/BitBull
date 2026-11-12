# BitBull — handoff (updated 4 Nov 2026)

Everything a new session (Claude Code, BitBull itself, or any agent) needs to carry on from the build
conversation of 7 Oct – 4 Nov 2026. Short version in `CLAUDE.md`; for agents *using* BitBull,
`agent-readme.md`. The same handoff is in Ditto (search "BitBull handoff 4 Nov 2026"), so in a
BitBull chat "catch me up on BitBull" gets it through the project-recall skill.

## Earlier names

BitBull has had two earlier names; everything (repo, distro, containers, paths, env vars, browser
keys, app identifier) now uses `bitbull`, and the company stays **BitBob Ltd** (`LICENSE`, author
fields, the planned code-signing identity). Only these still carry an old name, on purpose:

- `scripts/bitbull-wsl/migrate-from-bitbob.ps1` moves an install from the `bitbob` distro to
  `bitbull` by cloning the whole distro (`wsl --export/--import`) and renaming fixed paths inside the
  copy — deliberately not a tar of the agent-writable data folder unpacked as root (threat model
  P0 #8).
- Three first-run carry-overs keep their old-name lookups: the vault key
  (`%LOCALAPPDATA%\BitBob\vault.key`, copied by `link-helper.ps1` before it could mint a new one and
  orphan the vault), the launcher settings (`lib.rs`, `carry_over_legacy_settings`), and the
  browser's saved settings (`web/src/legacyStorage.ts`, which must stay main.tsx's first import).
- Older Ditto memories have the source `saygm-agent`; new ones use `bitbull` (`DITTO_SOURCE`).

SayGM (the model gateway) keeps its own name everywhere: `SAYGM_*` env vars, `config.saygm`,
provider ids. History below is written with today's name throughout.

## Added later on 4 Nov 2026

- **Claude.ai account import** (`tools/import-claude-export.mjs` + `POST /api/import/conversations`):
  the Settings → Privacy → Export data zip → projects (with docs) and chats with original dates.
- **QA Hound** (code name *swarm*: `server/src/swarm.ts`, `web/src/SwarmDialog.tsx`, top-bar button): reviewer
  models in their own sessions (review round, then challenge round), then the originating chat's
  model gives the verdict as a server-started turn the UI joins (`bitbull:turn-started`).
  Reviewer prompts are read-only by instruction; they run in the normal sandbox.
- **Ditto sync per project** (`projects.ditto_sync`, `POST /api/projects/:id/ditto-sync`,
  right-click menu + Project settings, ◆ in the sidebar): seed run in a "Ditto sync · <project>"
  chat; when on, the system prompt tells the agent Ditto is the project's record. Needed because
  a chat can only read its own workspace (OpenCode `external_directory` deny), so imported
  material must be seeded from inside each project.
- Activity: dates on events not from today; right-click the error badge for inspect / ask the
  agent / copy / clear. Hard-hat mark replaces "BB" in the UI; desktop `build.rs` re-runs on icon
  changes; session auto-title only when the title is still "New chat".

## State on 4 Nov 2026

`main` at f6e17ac, all merged and deployed to the live BitBull (http://localhost:8787). Built since
14 Oct, in order: detached resumable turns (`turns.ts`), white-labelling (`brand.json`), Hippius
encrypted mirror of uploads (`storage.ts`, `tools/hippius-setup.mjs`), a second BitBull on another
port for trying branches (`test-stack.ps1`), collapsible chat groups, network access on request
(`egress.ts` + `mcp.ts`: the agent asks, the user allows/denies, approvals memory-only), folders
as upload-a-copy or read-only link (`link.ps1`, `bitbull-links.sh`, `link-helper.ps1` for the folder
picker, filtered copies for folders with secrets, ↻ refresh), `copy-in.ps1`, `backup.ps1`, two
security hardening rounds (below), the Repositories view (`repos.ts`, `ReposDialog`), Files view with real paths
and sorting, `agent-readme.md`, then (4 Nov) the **Windows desktop app** (`desktop/`, Tauri 2:
checks WSL/distro/Docker/stack, runs the bitbull-wsl scripts with buttons, opens BitBull's UI in an
IPC-less window signed in from `.env`, tray) and **Claude project import**
(`tools/import-project.mjs` + the `claude-export/<project>/` layout; the Game Development
project was exported first).

## Owner and setup

- Owner: Tom (tommyhgunz14 on GitHub). Repo: https://github.com/bitbull-tech/BitBull (branch `main`), in the `bitbull-tech` GitHub organisation; images at `ghcr.io/bitbull-tech/bitbull` and `…/bitbull-egress`.
- Machine: Windows PC "TRIGGER", user `thetb`, Intel CPU, Node 24 on Windows. Working copy
  `D:\github\BitBull` (WSL path `/mnt/d/github/BitBull`).
- Runtime: WSL2 distro **`bitbull`** (locked down) runs Docker Engine; containers `bitbull-agent`,
  `bitbull-egress`, `bitbull-gateway`; UI at http://localhost:8787. The everyday `Ubuntu` distro was only
  used to bootstrap `bitbull`.
- Default model: **kimi-k3** (SayGM). Small model claude-haiku-4-5.
- Accounts/keys in use (values never stored here): SayGM, Ditto (MCP), GitHub (token +
  GITHUB_USER_NAME/EMAIL), Atlas (`atk_…`), Taostats (optional), Hippius (pending).

## Goal

1. Personal agent on SayGM (switch models freely) with Ditto as memory, own UI, backed up to
   GitHub, portable (local or by URL + key; may be opened to other users later).
2. A coding agent and one-stop shop for building on Bittensor: its subnets and services
   (Taostats, Atlas AI Studio, 404, Hippius, Ditto) wired in.

## Architecture (as built)

- **Server** (`server/src`): Hono on Node 22, `node:sqlite` (better-sqlite3 failed to build on
  Windows). SSE streaming. Single-owner bearer token `APP_TOKEN`.
- **Engines** behind one interface (`engines/types.ts`):
  - **OpenCode** (default): `opencode serve` spawned via `@opencode-ai/sdk` on a free localhost
    port; config passed in-process. Per-model provider by SayGM `api_shapes`. Custom primary agent
    `bitbull-plan` for read-only Plan mode; `question` tool disabled (UI can't answer it); retries
    surfaced as errors and aborted after 2; 401/402/403/404 explained via `gatewayHint()` and not
    retried. Subagents registered as `mode: subagent`; child sessions followed so their tool calls
    stream under the parent `task` card. Reloads when models, subagents or settings change
    (`configVersion`). Plugin `agent/opencode-plugin/bitbull-guard.js` blanks BitBull credentials in the
    agent's shell (`shell.env`) and redacts secret values in tool output (`tool.execute.after`).
  - **Claude Agent SDK**: `query()` with `ANTHROPIC_BASE_URL` = SayGM; `cleanEnv()` strips host
    Claude creds and BitBull keys; `agents` option for subagents; plan/acceptEdits/bypass modes; refuses
    non-Anthropic-shape models.
- **Projects**: own workspace dir `data/projects/<slug>-<id>`, instructions, colour, per-project
  integrations (Atlas/404 MCP). Chats can move between projects (engine session reset + recap).
- **Skills** (`skills/`) mirrored into every workspace `.claude/skills` (read by both engines) and
  backed up to Ditto in the background. 11 skills incl. coding-workflow, git-workflow,
  verify-changes, code-review, debug-systematically, repo-onboarding, project-recall,
  atlas-studio, taostats-api.
- **Subagents** (`subagents/*.md`): reviewer, challenger (read-only), debugger, tester, worker
  (write). Per-agent model via `SUBAGENT_MODEL_<NAME>`. Read-only on
  OpenCode = edit/bash deny and `task` off (a shell allowlist proved bypassable, 28 Oct review: `cat a>b`, `cat x | sh`, `xargs rm`; and a read agent could start a write agent);
  on Claude engine = no edit tools, no shell, no Task/Agent. Disabled in Plan mode. Tests in
  `server/src/subagents.test.ts` (8 passing).
- **Ditto**: MCP at https://api.heyditto.ai/mcp (Bearer key, 24 tools). Server archives every
  turn (`DITTO_ARCHIVE=turn`, vendorId-idempotent) and every skill; transient failures retried
  1s/5s/15s.
- **Integrations** registry (`integrations.ts`): Atlas (MCP alpha at mcp.dev.atlas.design, needs
  per-workspace enablement; exported workflow APIs via `tools/atlas-run.mjs`), 404.xyz (no public
  API yet; slots reserved), GitHub (global; token for git credential helper + `gh`; probe shows
  login/type/scopes), Taostats (key in settings).
- **Settings**: `.env` is the base; editable keys (`EDITABLE` in settings.ts) can be set in the UI,
  saved to `DATA_DIR/settings.local.json` (0600), applied live (`reloadConfig`, Ditto reset,
  OpenCode reload). Access/sandbox settings are .env-only.
- **UI** (`web/src`): projects sidebar, model picker (search, live prices), Plan toggle, to-do
  list, tool cards, subagent cards with live steps, uploads (files, paste, folders), Files dialog
  (browse/upload into any workspace folder), Settings (Status / Integrations / Configuration with
  inline edit / Appearance), Activity dock + full log + error toasts + review selection
  (tick entries or highlight text → Explain / Debug / Review prompts in the composer), Export
  (Copy last exchange full/compact, per-reply copy, whole chat, Markdown/JSON download).

## Sandbox and security model

- `bitbull-agent` container: non-root uid 1000, `read_only`, `cap_drop: ALL`, `no-new-privileges`,
  pids/mem/cpu limits, only `/data` writable (+ 1 GB `/tmp`). Internal network only; outbound via
  `bitbull-egress` (squid, `egress/allowlist.txt`, private ranges denied); inbound via `bitbull-gateway`
  (socat, 127.0.0.1:8787). Node uses `NODE_USE_ENV_PROXY=1`.
- `bitbull` WSL distro: no Windows drive automount, no interop, Docker `userns-remap` (container
  escape lands as an unprivileged uid). `~/bitbull-data` owned by the remapped uid, mode 700.
  Keep-alive: `start.ps1` runs a hidden `wsl -d bitbull -u root --exec sleep infinity` (Startup
  shortcut via `-InstallAtLogin`); WSL stops idle distros otherwise.
- Known residual risks (GAPS.md #11): the agent's shell runs as the same user as the server, so
  keys are protected against accidents (bitbull-guard + redaction) but not a determined agent.
  Planned fix: separate per-project tool container with no secrets.

## Incidents and lessons (don't repeat these)

- 14 Oct: BitBull ran `env` while debugging and printed the SayGM and Ditto keys into the chat →
  bitbull-guard plugin + server redaction added. **Tom must rotate SayGM + Ditto keys** (open).
- 14 Oct: SayGM returned **402 Payment Required** for kimi-k3 (balance/plan) — open for Tom.
- Proxy restart during deploy caused `ECONNREFUSED egress:3128` for Ditto → deploy now uses
  `squid -k reconfigure` (pid at /tmp/squid.pid), Ditto retries.
- 14 Oct: **a changed `egress/allowlist.txt` did not reach the running proxy.** The file is
  bind-mounted singly, so the container holds its inode, and the deploy replaces the whole
  directory (`rm -rf ~/BitBull && mv …`), giving it a new one — squid kept reading the old,
  deleted inode and `-k reconfigure` changed nothing. Found when `s3.hippius.com` was absent
  inside the container after a deploy that added it. `deploy.ps1` now diffs what the container
  actually sees against the file on disk and recreates the proxy only when they differ.
  Check after any allowlist change:
  `docker compose exec -T egress grep <domain> /etc/squid/allowlist.txt`.
- 28 Oct: BitBull's own full-repo review (kimi-k3) found the read-only subagent shell allowlist
  bypassable (`cat a>b`, `cat x | sh`, `find . | xargs rm`) and that read agents could start
  write agents. Fixed by removing the shell and delegation from read agents altogether
  (`opencodeAgentAccess`, `CLAUDE_READ_ONLY_DISALLOWED`), not by patching patterns. Same review:
  activity SSE replay/subscribe race (now subscribe-first, bounded queue), stored-file restore
  trusting `rel_path` from agent-writable `agent.db` (now `insideWorkspace()`), approved
  egress domains persisted in agent-writable `/data` (now memory-only), CI not running tests
  (now does), no backup of `bitbull-data` (`backup.ps1`). Lesson: anything the server reads back
  from `/data` is agent-controlled input.
- 28 Oct (second review, Claude Fable 5.1): **settings.local.json applied every key**, so an
  agent writing `APP_TOKEN` there took over BitBull at the next reload (confirmed, fixed: only
  `EDITABLE` keys are read, URLs removed from `EDITABLE`); the browser was an egress bypass via
  markdown images / brand CSS (fixed: CSP + images shown as links); Hippius keys weren't
  redacted (fixed); a failed upload read crashed the server (fixed). Still structural: the
  agent can read `APP_TOKEN` from the server's environment (GAPS #11).
- Windows PowerShell 5.1: `Start-Process -ArgumentList @(...)` doesn't quote items → pass one
  string. `{…}` in a `wsl … sh -c "…"` line is parsed as a script block → use a here-string piped
  to `sh`. Native-arg quoting differs between PS 5.1 and 7 → deploy writes a temp `.cmd`.
- WSL: `/mnt/d` is drvfs (root-owned, needs sudo for sed -i); CRLF in `.env` breaks values
  (deploy strips `\r`). Docker group = root-equivalent in a distro.
- OpenCode: `external_directory` denies paths outside the workspace (allowances for /tmp, tools,
  Atlas workflows); child-session title is `"<description> (@<agent> subagent)"`; task metadata
  carries `sessionId`; permission rules are last-match-wins.
- `useEffect` must not return a Promise (blank-screen bug, ErrorBoundary added).
- Blocking startup on network calls is bad (skills backup now background; status probes time out).

## Data layout (inside container `/data` = `~/bitbull-data` in `bitbull`)

`agent.db` (sessions, messages, projects, meta) · `workspace/` · `projects/<slug>-<id>/` (uploads/,
cloned repos, outputs, .claude/skills) · `integrations/atlas/workflows/` · `logs/server.log`,
`logs/activity.jsonl` · `settings.local.json` · `home/ cache/ config/ opencode-sandbox/
claude-sandbox/`. Files are **not** backed up off-machine yet (Hippius planned).

## Security swarm #2 and the fixes (5 Nov 2026)

Swarm (fable-5 + gpt-5.4, kimi-k3 handler) on the current tree for the open-source release:
verdict "fix first", one live RCE, four more highs. Verified and fixed here, with tests:

- **Hostile clone → RCE as the server (confirmed by PoC, was finding #1).** `git status` runs
  `core.fsmonitor` from the clone's OWN config, and a `filter.<x>.clean` reached through the
  repo's own `.gitattributes` — both executed in my reproduction, with the server's full env.
  Reachable because the agent clones what it is asked to and an upload can plant `.git/`.
  Fixed in `repos.ts` in three layers (no single one holds): a scrubbed env (git never sees
  BitBull's secrets), `-c` overrides for every nameable exec knob, and `execCapableConfig()` —
  a refusal when the repo's own config defines an exec-capable key, which is the only way to
  cover `filter.*`/`textconv` whose driver names are arbitrary. `repos-hostile.test.ts` asserts
  six vectors neither execute nor get inspected, and that ordinary clones still work.
- **`ditto_review` (my code from 4 Nov, finding #4):** it shells the Ditto CLI, which runs git
  in the same attacker-controlled clone → same vector; and `HOME` was `/data/home`, which the
  agent can write, so a planted `~/.gitconfig` steered that git. Now refuses via
  `execCapableConfig()` first, and runs with its own HOME plus `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`.
- **"Allow the whole domain" was public-suffix-blind (finding #6, found by both reviewers):**
  one click on `evil.github.io` approved `github.io` — every GitHub Pages site, i.e. a writable
  exfiltration channel. `domainOf()` now knows ~60 shared hosting/CDN/user-content suffixes and
  returns suffix+1 label; test covers it.
- **Ditto session-name header crash (mine, found in use, not by the swarm):** auto-titles end in
  `…` (U+2026) and HTTP headers are ByteStrings, so every save on a truncated title threw
  "Cannot convert argument to a ByteString". `headerSafe()` folds typography to ASCII; the
  one-shot title is now consumed only on a successful connect. `ditto.test.ts`.

Checked and NOT accepted: **finding #3 (Tauri IPC)** claims the desktop app's commands are
callable from the BitBull webview and the README's "no IPC" is false. Tauri 2's ACL source and
its own tests show window-scoped denial ("not allowed on window …"), and our capability lists
only `main`, so the BitBull window has no permissions. One swarm, static, no PoC — needs a
click-through proof before anything is redesigned.

Still open from that swarm, for the coding agent: `/vault-key` has no consent dialog (any local
process with a forged Origin can take the vault key — #2, real and worth the dialog); vault
values land in `process.env` and so in the OpenCode child's `/proc` (#5, the known shared-uid
residual, GAPS #11); host-mode `0.0.0.0` + `ALLOW_NO_AUTH` foot-gun (#7); the old-distro migration script
root tar follows planted symlinks (#8); `deploy.ps1` unquoted filename interpolation (#9);
storage restore writes plaintext before GCM verify (#10); swarm reviewers are full-capability
agents on hostile repos and their output is interpolated into the verdict prompt (#11); CI has
no `permissions:` block and tag-pinned actions (#12); redaction is exact-substring only (#13);
`npm audit`: server 5 (2 high), web 0. The handler also wrote `docs/THREAT-MODEL.md` and
`SECURITY.md` (uncommitted in its workspace).

## Ditto integration review (4 Nov 2026, from ditto-assistant/ditto-cli)

Done: per-chat Ditto threads for the turn archive (`X-Ditto-Session-Id`/`-Name`, one MCP
connection per thread in `ditto.ts`, idle-closed); `ditto_review` tool on BitBull's MCP
(`@heyditto/cli` in the image, runs server-side with the Ditto key; `verify-changes` and
`git-workflow` call for it before commit/PR); agent-readme + project-recall tell the agent to ask
the Ditto Main Agent (`send_message_to_agent`) for judgement questions; README/.env.example
describe giving BitBull its own claimable Ditto agent account (`heyditto init --name BitBull`).
Tom still has to: run that `init`, claim it, swap `DITTO_API_KEY`; enable the repo for Ditto
Review in his Ditto workspace (otherwise `ditto_review` returns the service's refusal).
Not done, deliberately: the engines' own Ditto MCP calls don't carry the thread headers
(OpenCode's MCP config is per server, not per chat); Ditto's inference router (SayGM-backed models,
recall/record) is worth evaluating at the device-token phase, not before.

## Vault and Open in Explorer (4 Nov 2026, late)

- `server/src/vault.ts` + `/api/vault*`: UI-entered secrets (`VAULT_KEYS`) encrypted in
  `DATA_DIR/vault.json`; key from the link helper (`/vault-key`, DPAPI file
  `%LOCALAPPDATA%\BitBull\vault.key`), sent by the page at load when on the PC; server keeps key
  and values in memory only; `readOverrides()` = file + vault; `updateSettings` routes secrets
  to the vault while unlocked; first unlock migrates secrets out of `settings.local.json`.
  Motivation: GAPS #11 (agent shares the server uid and could read that file).
- Link helper `/open {path}`: validated distro path under `bitbull-data` → `\\wsl.localhost\bitbull\…`
  → explorer.exe. `start.ps1`/`provision.sh` make `bitbull-data` 755 so Explorer can traverse it.

## QA Hound on the old clone (4 Nov 2026, fable-5 vs gpt-5.4, kimi-k3 as handler)

Reviewed the 3-week-old clone (a4f8d88). Everything it found had already been fixed upstream
except: symlink escape in the workspace file APIs (now closed: uploads and listing go through
`insideWorkspace()`, which realpaths the parent and refuses planted links), `?dir=.claude`
listing the root (now 400), empty listener-set keys in opencode.ts (now deleted), unknown
`level` on /api/activity widening the filter (now falls back to error), cache-read tokens
priced at full input rate (now `cacheReadTokens` at the cache rate), and the 20k Ditto archive
cap (documented in ditto.ts). Still structural: OpenCode's process inherits the secrets (the
guard plugin blanks them in shells; /proc remains, GAPS #11). Blind spots it named, not yet
reviewed by anyone: the new surface since (links.ts, storage.ts, repos.ts, swarm.ts, import,
desktop/), supply chain (no `npm audit` in CI, tag-pinned actions), db.ts, MCP/Ditto trust,
React XSS surface, serveStatic path. → run a swarm on the current tree with those as the target.

## Open items / next

1. **Rotate SayGM + Ditto keys** (leaked 14 Oct) if not yet done; resolve the SayGM 402 for kimi-k3.
2. Verify Atlas MCP with the new `atk_` key (MCP must be enabled per workspace by Atlas).
3. **Separate tool container with no secrets** (GAPS #11): the agent's shell still runs as the
   server's uid and can read `APP_TOKEN` from `/proc`; the Claude engine's shell inherits the
   SayGM key. Every other hardening is done; this is the structural one left.
4. **Clients** (`docs/CLIENTS.md`): Phase 2 desktop exists for Windows (`desktop/`, not yet
   built on Tom's PC: needs rustup + VS Build Tools, then `npm run tauri build`). Still to do:
   Phase 0.2–0.4 (client-core, token out of URLs, CORS, versioning) → Phase 1 per-device tokens
   with scopes (`capture:<project>` for scanning phones) → remote profiles in the desktop app →
   Phase 3 Linux install → Phase 4A iOS PWA + Cloudflare tunnel.
4b. **Import the other Claude projects**: export each with Claude ("export this project for
   BitBull", same layout as `claude-export/game-development/`), run `tools/import-project.mjs`, send
   the printed prompt so the agent seeds Ditto.
6. GAPS.md: checkpoints + diff + undo; parallel builds in git worktrees; approvals for
   push/delete/install; hooks; browser testing; spend caps; CI version tags + vuln scanning.

## How Tom works

- Prefers concise, plain-English answers; step-by-step PowerShell for anything he runs.
- Edits and commits on Windows; BitBull's own clone inside its workspace is separate (don't merge
  BitBull-made branches blindly — BitBull built a parallel `feat/copy-exchange`; the server-side export on
  main supersedes it).
- Wants errors surfaced, reviews done by subagents, and things verified before "done".

## Logo and the QA Hound detectives (7 Nov 2026)

New logo: a grinning grey bulldog in a red spiked collar with a τ name tag, supplied by Tom. Master at
`desktop/src-tauri/icons/source.png`. The full bust is used from 48px up; 32px and below use a
head crop, because the bust blurs and the τ is unreadable there.

QA Hound's detectives are Tom's art too: the bulldog as Sherlock (deerstalker, monocle, pipe,
magnifying glass, τ tag) in nine collar colours, cut from his parts sheet into a jointed puppet in
`web/src/assets/detectives/` (transparent WebP, ~108 KB in all): upper arms fixed at the shoulders,
forearms that turn at the elbow (pipe, glass), one torso (the blue body with its collar removed), and
per colour a collar (with tag) and a head lowered onto it so no white throat shows. The collar is
drawn over the head so the band stays whole on the right; on the left, where its end would
run into the jaw, it is cut away behind the head in the image itself. The pipe forearm
is baked turned out 12° and only swings ±3°, which keeps it off the face. The sheet had only six loose heads, so blue, green and orange are
hue-shifted copies of the teal/purple ones; the right upper arm is the left one mirrored (no τ on
it). Every layer is the same 242 × 217 canvas, pre-positioned, so `SwarmTheatre.tsx` stacks them in
one SVG and turns each about a pivot in those pixels (PIVOT, LENS, PIPE): the pipe lifts for a
puff (held clear of the face) with smoke growing out of the drawn plume, the glass sweeps with a glint, the head tilts, the
two lean in during cross-examination, then a hop and nod or a head-shake with the glass let fall.
Never mirror a whole figure: it would flip the τ. The cut-and-place script is not in the repo.

## QA Hound, dog icons and colour schemes (7 Nov 2026)

- **QA Swarm is now QA Hound** in everything a person reads: the top-bar button and its tooltip
  ("QA Hound - unleash multiple LLMs on your designated repo, folder or file to review, challenge
  each other and summarise a verdict and recommendations."), the dialog (whose start button is
  "Unleash the hounds"), the progress pill, reviewer chat titles ("QA Hound · …"), activity log
  lines and the reviewer prompts. Code, files and the API keep the name *swarm* (`swarm.ts`,
  `SwarmDialog.tsx`, `/api/swarm`), so nothing that calls it changes. Chats from earlier runs keep
  their "QA swarm · …" titles.
- **Every model is shown as a detective dog** (`web/src/dogs.tsx`, `assets/dogs/dog-1..9.webp`,
  96 px head-and-collar crops of the theatre heads): model picker, model browser, the chip on each
  reply, and the QA Hound room. Anthropic models wear orange, OpenAI green, Google blue; everything
  else gets pink, teal, maroon or purple from a hash of the model id, so a model is always the same
  dog. The theatre starts from that dog and only steps away from it to avoid two look-alikes in one
  room. `familyOf` in `dogs.tsx` mirrors the server's in `models.ts`; keep the two in step.
- **Colour schemes** (Settings → Appearance → Colours): seven presets and colour pickers for the
  background and sidebar of each theme. Only those two colours are stored, as `scheme` in
  `brand.json` via `PUT /api/appearance` (signed in; `GET /api/brand` stays public). The browser
  derives the rest in `web/src/brand.ts` (`schemeTokens`): panels, lines and ink from the
  background, and sidebar text and accent from the sidebar, light ink on dark colours and dark on
  light ones. `saveScheme` (server `brand.ts`) keeps the rest of the file, refuses a `brand.json`
  that is a link or invalid JSON, and is covered by `brand.test.ts`. See `docs/BRANDING.md`.

## Settings reorganised, and BitBull for macOS (7 Nov 2026)

- **Settings tabs.** Status is now an overview: one card per outside service plus the sandbox,
  each a link to its setup. **Integrations** holds every outside service, one card each with live
  status, docs link and its editable keys: SayGM (with Reload model list), Ditto, GitHub,
  Taostats, Atlas (with exported workflows), 404, Hippius. **Configuration** is BitBull's own
  workings: the vault, agent and runtime settings (the server's `bitbull` group), skills, subagents, runtime info. The server's setting groups are unchanged; the web
  splits them by id (`SERVICES` in `Settings.tsx`). Taostats has no live probe, so its card says
  whether a key is set.
- **macOS** (CLIENTS.md Phase 6, decisions there): `scripts/bitbull-mac/` (setup, deploy, start,
  status, logs, backup, link; bash 3.2), launcher support (`stack.rs` `Platform`, Mac checks via
  `status.sh`, actions through `/usr/bin/env … /bin/bash`), the link helper built into the app
  (`helper.rs`, Keychain via `security-framework`), `icon.icns`, bundle targets `all` with
  `minimumSystemVersion` 13.0, Mac wording in the web (Finder, "this computer"). CI: a proposed
  `macos.yml` (universal `.dmg`) and arm64 images in `ci.yml`, both in `ci-proposed/` for Tom to
  move into `.github/workflows/` himself. Not yet run on a Mac: scripts are shellchecked and
  `link.sh` was exercised on Linux; the Rust side has unit tests for both platforms' argv and the
  helper's routing, but the macOS-only lines (Keychain, `AppHandle::show`) were not compiled here.

## Model advisor and your usage history (9 Nov 2026)

- `server/src/advisor.ts`: `usageByModel()` aggregates `turns` (count, done, error, stopped,
  average duration of finished turns, last used) and assistant `messages.usage_json` (cost, tokens)
  per model. Nothing new is recorded; history goes back as far as the database does.
  `advise(task, strong)`: `needsOf` (vision from the wording) → `shortlist` (tools required, priced,
  your models first, then cheapest, capped at 150) → a table with prices and your record → one
  plain call on the advisor's native API (`complete`: Messages / generateContent / Responses /
  chat.completions, tested against a mock of each) → `parseAdvice` (JSON only, ids from the
  shortlist only, one per role, sizes clamped) → cost per pick from live prices × the advisor's
  size estimate. Logged to the activity log under saygm with what it cost.
- Routes: `GET /api/models/usage`, `POST /api/models/advise {task, strong?}` (signed in; each call
  costs a little). Settings: `ADVISOR_MODEL`, `ADVISOR_STRONG_MODEL` (editable, Configuration).
- Web: `ModelAdvisor.tsx` on the home screen above the starting points; "Your use" column and
  panel in `ModelsDialog.tsx`. Tests: `advisor.test.ts` (aggregation, shortlist, parsing).
- Possible next: count QA Hound evidence per model into the record, and tag turns by kind of work
  (code / writing / research) so the record can say "good at code here" rather than overall.

## Voice (9 Nov 2026)

- Tom's choices: listening via a Gemini model on SayGM (SayGM has no audio models); speaking via
  Piper in the container; all modes (mic button, read aloud, auto-speak when asked by voice,
  hands-free); one BitBull voice; settings per computer; global push-to-talk shortcut.
- Server: `server/src/voice.ts` (+ tests), routes `/api/voice`, `/api/voice/speak`,
  `/api/voice/transcribe`, config `VOICE_STT_MODEL`. Dockerfile `voice` stage pulls Piper and two
  voice packs, checked against `voice/piper.sha256`.
- Web: `web/src/voice/` (prefs, text, mic, speaker, useVoice, VoicePanel); Chat.tsx wires mic,
  hands-free, streaming speech and read aloud; Settings → Voice tab.
- Desktop: `tauri-plugin-global-shortcut` (Ctrl/Cmd+Shift+Space → `bitbull:ptt` DOM event into the
  BitBull window), `Info.plist` with the microphone prompt text. Cargo.lock updated.
- Checked: server tests and Piper in the cloud; web tsc; recording, WAV encoding, transcription
  call and the hands-free loop in headless Chromium with a fake microphone. **Not yet checked:**
  Gemini transcription through SayGM for real, WebView2's mic prompt, and the shortcut on Windows/Mac.
- Art: QA Hound dialog has the detective (`assets/qa-hound.webp`), Settings has the lab-coat
  bulldog (`assets/settings-dog.webp`), both with transparent backgrounds so they follow the scheme.

## BitBull's own voice, and the sidebar Archive (9 Nov 2026)

- Tom asked for a Scooby-Doo-like voice with Muttley's laugh; declined as a sound-alike and built
  an original character instead (Tom agreed): `server/src/dogvoice.ts`. LibriTTS speaker 54, Piper
  run at 0.8× length, then resampled (pitch and formants × 0.8), flutter + saturation + bass.
  Laughs in a reply ("haha", "lol", 😂, *laughs*) become a synthesised huffing chuckle (no
  recording). Voice id `bitbull`, now the default. Samples were sent to Tom; tune `DOG_PITCH`,
  `growl()` depth and `laugh()` if he wants it different.
- Archive: `archived_at` on projects and sessions (migration in db.ts), PATCH `{archived}` on
  `/api/projects/:id` and `/api/sessions/:id` (doesn't bump updated_at), sidebar Archive section
  (App.tsx `projectBlock`), archive button on project rows, menu items. Test: archive.test.ts.

## Getting files out without a CLI (9 Nov 2026)

- Prompted by a reply that wrote `cartoon-dog-voice/voice-brief.md` with no way to reach it but a shell.
- `server/src/outputs.ts` (+ tests): files written during a chat's turns (mtime inside a turn's
  window, skipping engine state/deps), a small zip writer (deflate, UTF-8 names), path checks via
  realpath. Routes `GET /api/sessions/:id/outputs` and `GET /api/projects/:id/download` (attachment,
  nosniff, CSP sandbox). `turns.forSession` in db.ts.
- Web: `ReplyFiles.tsx` under each reply; Files dialog gets per-file Download / Show and a folder
  .zip. Link helpers now reveal files too (`explorer /select,` on Windows, `open -R` on a Mac).

## Ditto Router, Ditto Review, QA Hound limits (9 Nov 2026)

- Ditto Router = provider routing for a model you choose, not a task-aware picker; the advisor stays
  the picker. Background work only, opt-in (`BACKGROUND_VIA`, `DITTO_ROUTER_KEY`,
  `DITTO_ROUTER_MODEL`; `server/src/router.ts`, `RouterPanel.tsx`). Advisor picks carry `router`
  and "Use for background work".
- Ditto Review per branch: `POST /api/projects/:id/repos/ditto-review` (`server/src/github.ts`)
  comments `@ditto review` on the branch's open PR.
- QA Hound: `server/src/hound.ts` (options, globs, findings parse/judge, PR event/body, tests);
  swarm.ts enforces budget/time from live `usage` events (new AgentEvent emitted by the OpenCode
  engine every few seconds), parses the verdict's ```qa-hound``` JSON block, posts to the PR.
  Chat renders that block as a findings table (`HoundFindings.tsx`).
- Tom's Ditto endpoint "Ditto Review" (developer.heyditto.ai) has two model routes,
  openai/gpt-6-luna → gm/gpt-6-luna and z-ai/glm-5.3-flash → gm/glm-5.3-flash (his SayGM key on
  Ditto), while billing is set to the Ditto balance. Raised with Tom; not changed.

## Window and page review, model picker makers and speed (10 Nov 2026)

- Window: `web/src/screen.ts` (getDisplayMedia, PNG frame ≤1920 wide) + Chat.tsx button/chip; a
  fresh frame goes with each send while shared. Headless test can't open a share picker: untested
  on a real desktop.
- Extension: `browser-extension/` (MV3; activeTab, scripting, storage; host localhost/127.0.0.1).
  Posts to `POST /api/captures` with APP_TOKEN; `server/src/captures.ts` holds it in memory and
  builds the Markdown brief; the open page polls `GET /api/captures/next` every 3 s and attaches
  screenshot + .md. Not yet loaded in a real Chrome.
- Speed: `turns.first_token_at` (migration) set on the first text/thinking event; advisor.ts
  `usageByModel` gives `firstTokenSeconds` (median of last 50). Picker: maker checkboxes
  (`makerOf`), sort Maker/Cheapest/Fastest.
- Follow-ups: launcher Checks card shows "checked Ns ago" + Re-check (it already re-ran every 6 s
  and after each action). Unused chats (no message, no turn) are no longer listed and are deleted
  after an hour (`sessions.listUsed` / `pruneUnused`). Sidebar "Select" mode with bulk Archive /
  Move / Delete (also "Select…" in a chat's menu). Model browser has the maker checkboxes and a
  Speed column.

## Family archive split out (10 Nov 2026)

BitBull is now only the coding agent and Bittensor one-stop shop. The family-archive workstream
lives in `D:\github\family-archive` (its own README lists what moved). Removed here: two skills,
one subagent, one tool, two docs, the likeness setting and its prompt text, and the wording across
the docs. Atlas, 404, Hippius, Ditto and linked folders stay as general Bittensor tools.
- Link helper on Windows: the desktop app now keeps `link-helper.ps1` running (checks port 8790
  every 10 s, starts it hidden if nothing answers; `keep_link_helper` in lib.rs). The folder menu
  polls for the helper while open and switches on by itself; its note names one script
  (start.ps1) and none at all inside the app.

## 404 integration corrected (11 Nov 2026)

- There is no 404 key and no 404 MCP. 404 (subnet 17) is used through the public
  404-Repo/404-game-recipe (clone, `npm install`, follow 404.md / GAME.md, harness/verify.mjs,
  harness/jam.mjs against your own URL); jam entries are a PR to 404-Repo/404-game-jam from
  Tom's GitHub. The MCP jam entrants used was Atlas's (already integrated).
- BitBull: `FOUR04_API_KEY/API_BASE/MCP_URL` removed; optional `FOUR04_MODEL_URL` +
  `FOUR04_MODEL_KEY` for 404's open model on Tom's own RunPod pod (probe: GET /models). New skill
  `skills/404-game-recipe`. Image now has Chromium (+ PUPPETEER_SKIP_DOWNLOAD /
  PUPPETEER_EXECUTABLE_PATH) so the recipe's puppeteer harness runs inside the sandbox.

## Connect Ditto: Ditto Router as a second gateway (11 Nov 2026)

- Settings → Integrations → Ditto → Connect Ditto (`server/src/dittoConnect.ts`, `web/src/DittoConnect.tsx`):
  Ditto's device sign-in, then endpoints `bitbull` (memory, all tools) and `bitbull-review` (no memory,
  no tools; re-enforced on every connect), a key each, and Ditto as `DEFAULT_MODEL`/background.
- Router models are `ditto-router/<id>` everywhere (`chatModels()` in models.ts); OpenCode gets
  per-shape Router providers plus `-review` twins for plan mode; the Claude engine runs any Router model.
- The endpoint's MCP catalog (`GET /v1/mcp`) is attached by BitBull (router.ts), never injected
  (`X-Ditto-Tool-Surface: mcp`): plan mode and QA Hound keep getting no MCP. Turn archive skips Router
  turns the endpoint records itself. Prices from Ditto's catalog (account key). See docs/ROUTER.md.
- Provider keys in Ditto (`server/src/providerKeys.ts`, `web/src/ProviderKeys.tsx`): paste a GM/Engy/
  Instant/OpenRouter/OpenAI/Anthropic/Google key and Save; the server runs `heyditto keys set` with the key
  on stdin and stores nothing. Connect asks for Ditto's `keys` sign-in (falls back to `login` on an older
  Ditto) and creates endpoints with `billingMode: both`. Open: bump the image's `@heyditto/cli` pin to the
  first release with `heyditto keys` (ditto-cli `peyton/keys-commands`) once it ships; the backend side is
  ditto backend `peyton/provider-keys-intent`, the approval page ditto-app `peyton/device-keys-intent`.

