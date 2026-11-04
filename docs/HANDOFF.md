# BitBob — handoff (updated 4 Nov 2026)

Everything a new session (Claude Code, BitBob itself, or any agent) needs to carry on from the build
conversation of 7 Oct – 4 Nov 2026. Short version in `CLAUDE.md`; for agents *using* BitBob,
`agent-readme.md`. The same handoff is in Ditto (search "BitBob handoff 4 Nov 2026"), so in a
BitBob chat "catch me up on BitBob" gets it through the project-recall skill.

## Renamed to BitBob (4 Nov 2026)

The product was **GM Agent** in repo **SayGMAgent** until 4 Nov 2026; Tom renamed it **BitBob —
The Bittensor Builder**. Everything was renamed in one commit, runtime identifiers included:
repo `tommyhgunz14/BitBob` (`D:\github\BitBob`), WSL distro `bitbob` (disk in
`%LOCALAPPDATA%\BitBob-WSL`), data `~/bitbob-data`, code copy `~/BitBob`, containers
`bitbob-agent` / `bitbob-egress` / `bitbob-gateway`, images `bitbob:local` / `bitbob-egress:local`,
links `/srv/bitbob-links` (+ `bitbob-src`, `bitbob-mirrors`, `/usr/local/sbin/bitbob-links`),
scripts `scripts/bitbob-wsl/`, env vars `BITBOB_*` (test-stack/deploy), MCP server `bitbob`
(tool `request_network_access`, header `x-bitbob-internal`), OpenCode plugin `bitbob-guard.js`,
browser keys `bitbob-*`, Ditto source `bitbob` (older memories keep `saygm-agent`), desktop app
identifier `io.bitbob.desktop`. SayGM (the model gateway) keeps its name everywhere: `SAYGM_*`
env vars, `config.saygm`, provider ids. Older Ditto memories, chats and this file's history still
say "GM"; read them as BitBob. The live stack was reinstalled fresh under the new names
(old `gm` distro unregistered after `backup.ps1`).

## Added later on 4 Nov 2026

- **Claude.ai account import** (`tools/import-claude-export.mjs` + `POST /api/import/conversations`):
  the Settings → Privacy → Export data zip → projects (with docs) and chats with original dates.
- **QA swarm** (`server/src/swarm.ts`, `web/src/SwarmDialog.tsx`, top-bar button): reviewer
  models in their own sessions (review round, then challenge round), then the originating chat's
  model gives the verdict as a server-started turn the UI joins (`bitbob:turn-started`).
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

`main` at f6e17ac, all merged and deployed to the live BitBob (http://localhost:8787). Built since
14 Oct, in order: detached resumable turns (`turns.ts`), white-labelling (`brand.json`), Hippius
encrypted mirror of uploads (`storage.ts`, `tools/hippius-setup.mjs`), a second BitBob on another
port for trying branches (`test-stack.ps1`), collapsible chat groups, network access on request
(`egress.ts` + `mcp.ts`: the agent asks, the user allows/denies, approvals memory-only), folders
as upload-a-copy or read-only link (`link.ps1`, `bitbob-links.sh`, `link-helper.ps1` for the folder
picker, filtered copies for folders with secrets, ↻ refresh), `copy-in.ps1`, `backup.ps1`, two
security hardening rounds (below), the capture/ingest pipeline (`docs/CAPTURE.md`,
`tools/ingest.mjs`), the Repositories view (`repos.ts`, `ReposDialog`), Files view with real paths
and sorting, `agent-readme.md`, then (4 Nov) the **Windows desktop app** (`desktop/`, Tauri 2:
checks WSL/distro/Docker/stack, runs the bitbob-wsl scripts with buttons, opens BitBob's UI in an
IPC-less window signed in from `.env`, tray) and **Claude project import**
(`tools/import-project.mjs` + the `claude-export/<project>/` layout; the Game Development
project was exported first).

## Owner and setup

- Owner: Tom (tommyhgunz14 on GitHub). Repo: https://github.com/tommyhgunz14/BitBob (branch `main`).
- Machine: Windows PC "TRIGGER", user `thetb`, Intel CPU, Node 24 on Windows. Working copy
  `D:\github\BitBob` (WSL path `/mnt/d/github/BitBob`).
- Runtime: WSL2 distro **`bitbob`** (locked down) runs Docker Engine; containers `bitbob-agent`,
  `bitbob-egress`, `bitbob-gateway`; UI at http://localhost:8787. The everyday `Ubuntu` distro was only
  used to bootstrap `bitbob`.
- Default model: **kimi-k3** (SayGM). Small model claude-haiku-4-5. Heritage policy set to
  `private-likeness`.
- Accounts/keys in use (values never stored here): SayGM, Ditto (MCP), GitHub (token +
  GITHUB_USER_NAME/EMAIL), Atlas (`atk_…`), Taostats (optional), Hippius (pending).

## Goal

1. Personal agent on SayGM (switch models freely) with Ditto as memory, own UI, backed up to
   GitHub, portable (local or by URL + key; may be opened to other users later).
2. End goal: build custom historical/hereditary experiences — old photos, film and documents
   "brought back to life and dramatised via video" — combining SayGM LLMs, Atlas AI Studio
   (release 0.38 cinematic generation) / 404.xyz, agentic coding and uploads. Governed by the
   WW2 Heritage Framework grounding rule (never state a fact about a real person without a source;
   likeness policy `ground-only` or `private-likeness`).

## Architecture (as built)

- **Server** (`server/src`): Hono on Node 22, `node:sqlite` (better-sqlite3 failed to build on
  Windows). SSE streaming. Single-owner bearer token `APP_TOKEN`.
- **Engines** behind one interface (`engines/types.ts`):
  - **OpenCode** (default): `opencode serve` spawned via `@opencode-ai/sdk` on a free localhost
    port; config passed in-process. Per-model provider by SayGM `api_shapes`. Custom primary agent
    `bitbob-plan` for read-only Plan mode; `question` tool disabled (UI can't answer it); retries
    surfaced as errors and aborted after 2; 401/402/403/404 explained via `gatewayHint()` and not
    retried. Subagents registered as `mode: subagent`; child sessions followed so their tool calls
    stream under the parent `task` card. Reloads when models, subagents or settings change
    (`configVersion`). Plugin `agent/opencode-plugin/bitbob-guard.js` blanks BitBob credentials in the
    agent's shell (`shell.env`) and redacts secret values in tool output (`tool.execute.after`).
  - **Claude Agent SDK**: `query()` with `ANTHROPIC_BASE_URL` = SayGM; `cleanEnv()` strips host
    Claude creds and BitBob keys; `agents` option for subagents; plan/acceptEdits/bypass modes; refuses
    non-Anthropic-shape models.
- **Projects**: own workspace dir `data/projects/<slug>-<id>`, instructions, colour, per-project
  integrations (Atlas/404 MCP). Chats can move between projects (engine session reset + recap).
- **Skills** (`skills/`) mirrored into every workspace `.claude/skills` (read by both engines) and
  backed up to Ditto in the background. 11 skills incl. coding-workflow, git-workflow,
  verify-changes, code-review, debug-systematically, repo-onboarding, project-recall,
  archive-ingest, heritage-experience, atlas-studio, taostats-api.
- **Subagents** (`subagents/*.md`): reviewer, challenger (read-only), debugger, tester, worker
  (write), fact-checker (read-only). Per-agent model via `SUBAGENT_MODEL_<NAME>`. Read-only on
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

- `bitbob-agent` container: non-root uid 1000, `read_only`, `cap_drop: ALL`, `no-new-privileges`,
  pids/mem/cpu limits, only `/data` writable (+ 1 GB `/tmp`). Internal network only; outbound via
  `bitbob-egress` (squid, `egress/allowlist.txt`, private ranges denied); inbound via `bitbob-gateway`
  (socat, 127.0.0.1:8787). Node uses `NODE_USE_ENV_PROXY=1`.
- `bitbob` WSL distro: no Windows drive automount, no interop, Docker `userns-remap` (container
  escape lands as an unprivileged uid). `~/bitbob-data` owned by the remapped uid, mode 700.
  Keep-alive: `start.ps1` runs a hidden `wsl -d bitbob -u root --exec sleep infinity` (Startup
  shortcut via `-InstallAtLogin`); WSL stops idle distros otherwise.
- Known residual risks (GAPS.md #11): the agent's shell runs as the same user as the server, so
  keys are protected against accidents (bitbob-guard + redaction) but not a determined agent.
  Planned fix: separate per-project tool container with no secrets.

## Incidents and lessons (don't repeat these)

- 14 Oct: BitBob ran `env` while debugging and printed the SayGM and Ditto keys into the chat →
  bitbob-guard plugin + server redaction added. **Tom must rotate SayGM + Ditto keys** (open).
- 14 Oct: SayGM returned **402 Payment Required** for kimi-k3 (balance/plan) — open for Tom.
- Proxy restart during deploy caused `ECONNREFUSED egress:3128` for Ditto → deploy now uses
  `squid -k reconfigure` (pid at /tmp/squid.pid), Ditto retries.
- 14 Oct: **a changed `egress/allowlist.txt` did not reach the running proxy.** The file is
  bind-mounted singly, so the container holds its inode, and the deploy replaces the whole
  directory (`rm -rf ~/BitBob && mv …`), giving it a new one — squid kept reading the old,
  deleted inode and `-k reconfigure` changed nothing. Found when `s3.hippius.com` was absent
  inside the container after a deploy that added it. `deploy.ps1` now diffs what the container
  actually sees against the file on disk and recreates the proxy only when they differ.
  Check after any allowlist change:
  `docker compose exec -T egress grep <domain> /etc/squid/allowlist.txt`.
- 28 Oct: BitBob's own full-repo review (kimi-k3) found the read-only subagent shell allowlist
  bypassable (`cat a>b`, `cat x | sh`, `find . | xargs rm`) and that read agents could start
  write agents. Fixed by removing the shell and delegation from read agents altogether
  (`opencodeAgentAccess`, `CLAUDE_READ_ONLY_DISALLOWED`), not by patching patterns. Same review:
  activity SSE replay/subscribe race (now subscribe-first, bounded queue), stored-file restore
  trusting `rel_path` from agent-writable `agent.db` (now `insideWorkspace()`), approved
  egress domains persisted in agent-writable `/data` (now memory-only), CI not running tests
  (now does), no backup of `bitbob-data` (`backup.ps1`). Lesson: anything the server reads back
  from `/data` is agent-controlled input.
- 28 Oct (second review, Claude Fable 5.1): **settings.local.json applied every key**, so an
  agent writing `APP_TOKEN` there took over BitBob at the next reload (confirmed, fixed: only
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

## Data layout (inside container `/data` = `~/bitbob-data` in `bitbob`)

`agent.db` (sessions, messages, projects, meta) · `workspace/` · `projects/<slug>-<id>/` (uploads/,
cloned repos, outputs, .claude/skills) · `integrations/atlas/workflows/` · `logs/server.log`,
`logs/activity.jsonl` · `settings.local.json` · `home/ cache/ config/ opencode-sandbox/
claude-sandbox/`. Files are **not** backed up off-machine yet (Hippius planned).

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
   BitBob", same layout as `claude-export/game-development/`), run `tools/import-project.mjs`, send
   the printed prompt so the agent seeds Ditto.
5. **Capture** (`docs/CAPTURE.md`): route 1 (phones → OneDrive → linked folder → ingest) works
   now; route 2 (phone capture page → BitBob inbox) follows Phase 1.
6. GAPS.md: checkpoints + diff + undo; parallel builds in git worktrees; approvals for
   push/delete/install; hooks; browser testing; spend caps; CI version tags + vuln scanning.

## How Tom works

- Prefers concise, plain-English answers; step-by-step PowerShell for anything he runs.
- Edits and commits on Windows; BitBob's own clone inside its workspace is separate (don't merge
  BitBob-made branches blindly — BitBob built a parallel `feat/copy-exchange`; the server-side export on
  main supersedes it).
- Wants errors surfaced, reviews done by subagents, and things verified before "done".
