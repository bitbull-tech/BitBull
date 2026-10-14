# GM Agent — handoff (14 Oct 2026)

Everything a new session (Claude Code, or any agent) needs to carry on from the build
conversation of 7–14 Oct 2026. Short version in `CLAUDE.md`.

## Owner and setup

- Owner: Tom (tommyhgunz14 on GitHub). Repo: https://github.com/tommyhgunz14/SayGMAgent (branch `main`).
- Machine: Windows PC "TRIGGER", user `thetb`, Intel CPU, Node 24 on Windows. Working copy
  `D:\github\SayGMAgent` (WSL path `/mnt/d/github/SayGMAgent`).
- Runtime: WSL2 distro **`gm`** (locked down) runs Docker Engine; containers `gm-agent`,
  `gm-egress`, `gm-gateway`; UI at http://localhost:8787. The everyday `Ubuntu` distro was only
  used to bootstrap `gm`.
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
    `gm-plan` for read-only Plan mode; `question` tool disabled (UI can't answer it); retries
    surfaced as errors and aborted after 2; 401/402/403/404 explained via `gatewayHint()` and not
    retried. Subagents registered as `mode: subagent`; child sessions followed so their tool calls
    stream under the parent `task` card. Reloads when models, subagents or settings change
    (`configVersion`). Plugin `agent/opencode-plugin/gm-guard.js` blanks GM credentials in the
    agent's shell (`shell.env`) and redacts secret values in tool output (`tool.execute.after`).
  - **Claude Agent SDK**: `query()` with `ANTHROPIC_BASE_URL` = SayGM; `cleanEnv()` strips host
    Claude creds and GM keys; `agents` option for subagents; plan/acceptEdits/bypass modes; refuses
    non-Anthropic-shape models.
- **Projects**: own workspace dir `data/projects/<slug>-<id>`, instructions, colour, per-project
  integrations (Atlas/404 MCP). Chats can move between projects (engine session reset + recap).
- **Skills** (`skills/`) mirrored into every workspace `.claude/skills` (read by both engines) and
  backed up to Ditto in the background. 11 skills incl. coding-workflow, git-workflow,
  verify-changes, code-review, debug-systematically, repo-onboarding, project-recall,
  archive-ingest, heritage-experience, atlas-studio, taostats-api.
- **Subagents** (`subagents/*.md`): reviewer, challenger (read-only), debugger, tester, worker
  (write), fact-checker (read-only). Per-agent model via `SUBAGENT_MODEL_<NAME>`. Read-only on
  OpenCode = edit deny + shell allowlist (`READ_ONLY_BASH`, last-match-wins, redirects denied);
  on Claude engine = no edit tools and no shell. Disabled in Plan mode. Tests in
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

- `gm-agent` container: non-root uid 1000, `read_only`, `cap_drop: ALL`, `no-new-privileges`,
  pids/mem/cpu limits, only `/data` writable (+ 1 GB `/tmp`). Internal network only; outbound via
  `gm-egress` (squid, `egress/allowlist.txt`, private ranges denied); inbound via `gm-gateway`
  (socat, 127.0.0.1:8787). Node uses `NODE_USE_ENV_PROXY=1`.
- `gm` WSL distro: no Windows drive automount, no interop, Docker `userns-remap` (container
  escape lands as an unprivileged uid). `~/gm-data` owned by the remapped uid, mode 700.
  Keep-alive: `start.ps1` runs a hidden `wsl -d gm -u root --exec sleep infinity` (Startup
  shortcut via `-InstallAtLogin`); WSL stops idle distros otherwise.
- Known residual risks (GAPS.md #11): the agent's shell runs as the same user as the server, so
  keys are protected against accidents (gm-guard + redaction) but not a determined agent.
  Planned fix: separate per-project tool container with no secrets.

## Incidents and lessons (don't repeat these)

- 14 Oct: GM ran `env` while debugging and printed the SayGM and Ditto keys into the chat →
  gm-guard plugin + server redaction added. **Tom must rotate SayGM + Ditto keys** (open).
- 14 Oct: SayGM returned **402 Payment Required** for kimi-k3 (balance/plan) — open for Tom.
- Proxy restart during deploy caused `ECONNREFUSED egress:3128` for Ditto → deploy now uses
  `squid -k reconfigure` (pid at /tmp/squid.pid), Ditto retries.
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

## Data layout (inside container `/data` = `~/gm-data` in `gm`)

`agent.db` (sessions, messages, projects, meta) · `workspace/` · `projects/<slug>-<id>/` (uploads/,
cloned repos, outputs, .claude/skills) · `integrations/atlas/workflows/` · `logs/server.log`,
`logs/activity.jsonl` · `settings.local.json` · `home/ cache/ config/ opencode-sandbox/
claude-sandbox/`. Files are **not** backed up off-machine yet (Hippius planned).

## Open items / next

1. **Rotate SayGM + Ditto keys**; delete the chat that printed them; resolve the SayGM 402.
2. **Hippius storage** (docs/STORAGE.md): server-side S3 client to `https://s3.hippius.com`
   (region `decentralized`, path-style), scoped sub-token for bucket `gm-agent`, client-side
   AES-256-GCM, Ditto memory as the index (filename, project, description, key, sha256),
   `s3.hippius.com` on the allowlist. Tom is recovering a missing Hippius seed first.
3. Verify Atlas MCP with the new `atk_` key (MCP must be enabled per workspace by Atlas).
4. GAPS.md priorities: checkpoints + diff + undo; parallel builds in git worktrees (best-of-N
   across models, compare view); approvals for push/delete/install; hooks; browser testing
   (Playwright MCP); background/scheduled runs; spend caps; separate tool container; multi-user.
5. **Desktop / Linux / iOS** — now planned and decided in **`docs/CLIENTS.md`** (Tauri 2 desktop
   that also manages the local Docker stack; iOS as a PWA first; per-device tokens before
   anything leaves localhost; Phase 0 = detached resumable turns). Original sketch below:
   - The server API is the contract (`README.md` → API table; SSE for turns and activity). Clients
     should stay thin.
   - **Linux**: run `docker compose up -d --build` directly (no WSL scripts); add a systemd unit +
     install script; same hardening; consider rootless Docker or userns-remap.
   - **Desktop (Windows/macOS/Linux)**: a Tauri (or Electron) shell around `web/` that either
     manages the local Docker stack (start/stop/deploy/status) or connects to a remote GM by
     URL + token; tray icon, notifications for errors/finished turns, native file drag-drop.
   - **iOS**: start as a PWA against a remote GM over HTTPS; then a SwiftUI client (chat, projects,
     uploads from Photos/Files, push notifications). Needs: HTTPS exposure (Cloudflare Tunnel or
     Caddy), stronger auth than one shared token (per-device tokens or OAuth), and upload resume
     for large media.
   - Shared needs: per-device auth, a versioned API, notifications (turn finished / error),
     background uploads.

## How Tom works

- Prefers concise, plain-English answers; step-by-step PowerShell for anything he runs.
- Edits and commits on Windows; GM's own clone inside its workspace is separate (don't merge
  GM-made branches blindly — GM built a parallel `feat/copy-exchange`; the server-side export on
  main supersedes it).
- Wants errors surfaced, reviews done by subagents, and things verified before "done".
