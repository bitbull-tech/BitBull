# GM Agent (SayGMAgent)

A personal agent on top of **[SayGM](https://saygm.com)** (one key, many models, switch
any time), with **[Ditto](https://heyditto.ai)** as long-term memory, two pluggable agent
engines (**OpenCode** and the **Claude Agent SDK**) and its own web UI.

- Chat UI with streaming, tool-call view, per-message model switching
- Turns run on the server, not in your tab: close it, sleep the laptop, come back, and the
  chat picks up where it left off
- Light and dark, and white-labelled from one `brand.json` — name, logo and every colour
- Engine per chat: **OpenCode** (native for every model) or **Claude Agent SDK**
- Ditto MCP wired into the agent + every turn and skill archived to Ditto
- Skills in `/skills`, versioned in Git, shared by both engines
- One Docker image, one data volume; reachable by URL with a bearer token
- `POST /api/v1/chat` for scripts and other agents

New here (or a new agent session)? Start with [CLAUDE.md](CLAUDE.md) and [docs/HANDOFF.md](docs/HANDOFF.md).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the
OpenCode-vs-Agent-SDK proposal.

## Quick start (local)

Requires Node 22.13+ (uses Node's built-in SQLite, so nothing needs compiling).

```bash
git clone https://github.com/tommyhgunz14/SayGMAgent.git
cd SayGMAgent
cp .env.example .env          # fill in APP_TOKEN, SAYGM_API_KEY, DITTO_API_KEY
npm run setup                 # installs server + web deps
npm run dev                   # API on :8787, UI on http://localhost:5173
```

Open the UI, paste your `APP_TOKEN`, start a chat.

Production build without Docker:

```bash
npm run build && npm start    # UI + API together on :8787
```

## Run sandboxed (recommended)

The agent can run shell commands, so it runs in a hardened container: an unprivileged
user with no Linux capabilities, a read-only system, and only its data folder writable.
Its network is internal. The only way out is an egress proxy that allows just the
domains in [`egress/allowlist.txt`](egress/allowlist.txt) plus any you approve in the UI
(see "Network access" below), so the agent can't reach your home network, Windows, or any
site you haven't allowed. Outside the container the agent's
shell is switched off (set `ALLOW_HOST_SHELL=true` only if you accept the risk).

```bash
docker compose up -d --build      # UI + API on http://localhost:8787 (this computer only)
docker compose logs -f gm-agent   # or the Activity panel in the UI
docker compose logs -f egress     # every outbound request, allowed or refused
docker compose exec egress squid -k reconfigure   # after editing egress/allowlist.txt (no dropped connections)
docker compose down               # stop
```

Optional limits in `.env`: `GM_CPUS` (default 4), `GM_MEMORY` (default 6g), `GM_PORT`
(default 8787), `GM_DATA_DIR` (default `./data`).

On Windows, use the locked-down WSL distro (below) rather than your everyday Ubuntu.
`npm run dev` still works for UI development, with the agent's shell disabled.

## What runs where

Three layers, from the outside in. Each only sees what the layer outside hands it.

```
Windows  ── D:\github\SayGMAgent (source, .env, git)      ── deploy.ps1 copies code + .env in ──┐
                                                                                                 ▼
WSL distro "gm" (no Windows drives, no Windows programs, Docker with userns-remap)
   ~/SayGMAgent   code copy, replaced on every deploy
   ~/gm-data      ALL live data (chats, workspaces, uploads, logs)  ── mounted as /data ──┐
                                                                                         ▼
Docker (network "sandbox" is internal: no internet, no LAN, no host)
   gm-gateway  socat: 127.0.0.1:8787 on your PC → gm-agent:8787 (the only way in)
   gm-agent    server + UI + agent engines; runs as uid 1000, read-only filesystem
   gm-egress   squid allowlist proxy (the only way out)
```

### Outside Docker: Windows

| What | Where | Notes |
|---|---|---|
| Source code, git history | `D:\github\SayGMAgent` | You edit and commit here. GM never sees this folder. |
| Secrets and settings | `D:\github\SayGMAgent\.env` | Never committed (`.gitignore`). Copied into `gm` by `deploy.ps1`. |
| Scripts | `scripts\gm-wsl\setup.ps1`, `deploy.ps1`, `start.ps1` | One-time setup, ship changes, keep running. |
| Start at login | Startup folder shortcut "GM Agent" | Created by `start.ps1 -InstallAtLogin`. |
| The `gm` distro's disk | `%LOCALAPPDATA%\GM-WSL\disk` | A virtual disk holding everything in the next table. |
| Old data from before the sandbox | `D:\github\SayGMAgent\data` | Copied into `gm` once at setup; no longer used. |

### Outside Docker: inside the `gm` WSL distro

| What | Where | Notes |
|---|---|---|
| Lockdown | `/etc/wsl.conf` | No drive mounts, no Windows interop, Docker started at boot. |
| Docker Engine | `/etc/docker/daemon.json` | `userns-remap`: container users map to unprivileged IDs here. |
| Deployed code + `.env` | `~/SayGMAgent` | Replaced on each deploy; don't edit here. |
| **Live data** | `~/gm-data` | Owned by the remapped container user (mode 700). Read it as root: `wsl -d gm -u root`, or `\\wsl.localhost\gm\home\<you>\gm-data` from an admin tool. |

### Inside Docker

| Container | Image contents | Can write | Network |
|---|---|---|---|
| `gm-agent` | Node 22, built server + web UI, OpenCode, Claude Agent SDK, `agent/`, `skills/`, `subagents/`, `tools/`; git, gh, ripgrep, Python, ffmpeg, exiftool, poppler, tesseract | `/data` (= `~/gm-data`) and a 1 GB `/tmp` | `sandbox` only; HTTP(S) via `egress` |
| `gm-egress` | squid; `egress/allowlist.txt` mounted read-only | nothing persistent | `sandbox` + `outside` |
| `gm-gateway` | socat | nothing | `sandbox` + `outside`; publishes 127.0.0.1:8787 |

`gm-agent` gets every variable in `.env` plus `HTTPS_PROXY=http://egress:3128`. Inside it,
`HOME`, caches and both engines' state live under `/data`, because the rest of the
filesystem is read-only.

## Where your data goes

Everything GM stores is under `/data` in the container (`~/gm-data` in the `gm` distro):

```
/data
  agent.db                      chats, messages, tool calls, projects (SQLite)
  workspace/                    workspace for chats outside projects
  projects/<name>-<id>/         one workspace per project
     uploads/<chat-id>/…        files attached in a chat
     uploads/<folder>/…         folders dropped on a chat (structure kept)
     <any folder>/…             files added with the Files dialog, cloned repos, agent output
     .claude/skills/            skills mirrored in on start (don't edit; edit /skills in git)
  integrations/atlas/workflows/ exported Atlas workflow specs (contain credentials)
  logs/server.log               raw server output (secrets redacted)
  logs/activity.jsonl           the Activity feed (secrets redacted)
  settings.local.json           keys and settings saved from the UI (mode 600)
  home/ cache/ config/ opencode-sandbox/ claude-sandbox/   tool and engine state
```

How each kind of upload is captured:

| You do | It lands in | Recorded in |
|---|---|---|
| Attach files in the composer (paperclip, paste, drop) | `<workspace>/uploads/<first 8 of chat id>/` | The message's attachment list in `agent.db`; the agent is told the paths |
| Drop a folder on the chat | `<workspace>/uploads/<folder>/…` (dependency and build folders skipped) | Same; the folder path is attached to your next message |
| Files dialog (top bar → Files) | `<workspace>/<folder you choose>/…`, structure kept; existing files kept unless you tick Replace | Activity log (`upload`) |
| Ask the agent to clone or create files | Wherever it works in the workspace | Tool calls in the chat and Activity log |

What leaves the machine, and what doesn't:

- **Ditto** receives the *text* of each chat turn (`DITTO_ARCHIVE=turn`) and every skill.
  It does not receive files.
- **SayGM** receives the conversation sent to the model, including any file contents the
  agent reads into it.
- **GitHub** receives only what the agent commits and pushes.
- **Hippius** receives everything you upload, encrypted on this machine first (AES-256-GCM)
  and indexed in Ditto. Set it up in Settings → Configuration → Hippius storage, or in
  `.env`; see [docs/STORAGE.md](docs/STORAGE.md). With `STORAGE_MIRROR=off`, nothing is sent.
  Still back up `~/gm-data` for the database and workspaces (for example
  `wsl -d gm -u root -- tar -czf - -C /home/<you> gm-data > gm-data.tgz`): Hippius holds the
  files you uploaded, not the chats.

## On Windows: the locked-down WSL distro

A normal WSL distro mounts every Windows drive and can launch Windows programs, so it is a
thin wall. `scripts/gm-wsl/` creates a separate distro, `gm`, with both switched off and
Docker running with user-namespace remapping (a container escape lands as an unprivileged
user that can't mount drives).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\setup.ps1                 # once (uses Docker in your Ubuntu distro to get a clean image)
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\deploy.ps1                # ship code and .env changes, rebuild
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\start.ps1 -InstallAtLogin  # keep GM running; start at login
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\start.ps1 -Stop
```

### Trying a branch before you merge it

A second, isolated GM on another port, with its own containers and its own empty data
folder, built from whatever is in your checkout right now. The live stack on 8787 is never
touched.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\test-stack.ps1            # start on http://localhost:8788
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\test-stack.ps1 -Logs      # follow its log
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\test-stack.ps1 -Down      # stop, keep its data
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\test-stack.ps1 -Destroy   # stop and delete its data
```

It uses the same `.env`, so the same access token unlocks it, but its chats, workspaces and
settings are entirely separate (`~/gm-data-test` in the distro). `-Port` and `-Name` let you
run more than one.

## Run with Docker (any server)

```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```

State lives in `./data` (or `GM_DATA_DIR`). Put it behind HTTPS (Caddy, nginx or a
Cloudflare Tunnel) before exposing it: the agent can run shell commands in its workspace.

## Keys and settings: `.env` or the UI

`.env` is the base. Keys and settings marked **Edit** in Settings → Configuration (model
keys, Ditto, GitHub, Atlas, 404, Taostats, default models, heritage policy, upload size)
can also be set from the UI. They're saved on the server in `data/settings.local.json`
(mode 600, never in git), override `.env`, and apply immediately: no deploy or restart.
**Use .env** removes an override. Each value shows where it comes from: `.env`,
`set here` or `default`.

Access and sandbox settings (`APP_TOKEN`, `ALLOW_*`, `GM_SANDBOX`, permissions, ports,
paths, proxy) can only be changed in `.env` plus a deploy, so a browser session can't
lower the walls. The UI can't write your Windows `.env` (the container can't see Windows,
by design); copy a value there yourself if you want it to be the long-term default.

GM's own credentials (SayGM, Ditto, Atlas, 404, `APP_TOKEN`) are blanked in every shell the
agent starts, and any known key that turns up in a tool's output is replaced with
`[REDACTED]` before the model, the chat history or Ditto sees it
([`agent/opencode-plugin/gm-guard.js`](agent/opencode-plugin/gm-guard.js) for OpenCode; the
server redacts again for both engines). Keys meant for the agent (`GITHUB_TOKEN`,
`TAOSTATS_API_KEY`) stay available to it but are masked in output. This prevents accidental
leaks; it isn't a hard wall, because the shell runs as the same user as GM (GAPS.md item 11).
Use scoped keys where the service offers them.

## Activity and errors

The **Activity** bar under the chat (collapsed by default) shows the latest event and a red
badge when something has failed. Expand it for recent activity (all, errors and warnings,
or this chat); **Full log** opens everything with search, filters and download. Errors also
pop up as alerts in the top-right corner and show as a badge in the sidebar. It records chat
turns (model, time, tokens, cost), every tool call and subagent, uploads, Ditto and SayGM
problems and server warnings. Stored in `data/logs/activity.jsonl`, secrets redacted.

To get the agent's view on something: tick entries in the log and choose **Explain**,
**Debug** or **Review with subagents**, or highlight text in the log or in a reply and use
the **Ask agent** buttons that appear. Either way the excerpt is put in the message box with
the request, so you can add your notes before sending.

## Make it yours (white-labelling)

Name, tagline, logos and every colour come from `brand.json` in the data folder, with the
image files in `brand/` beside it. Edit it and reload the page — nothing is rebuilt or
deployed. `docs/brand.example.json` is a starting point and
[docs/BRANDING.md](docs/BRANDING.md) lists every token you can override. Settings →
Appearance shows what is in force.

## Export a chat

One click: **Copy last** in the top bar copies your latest request and the agent's reply,
with its tool calls, that turn's activity log and a short description of how GM is set up,
as Markdown ready to paste into Claude, ChatGPT, Codex or another GM chat. **Copy for agent**
under any reply does the same for that exchange.

Under each reply, **Copy for agent: full · prompt + reply** copies that exchange either
way; **prompt + reply** is the short form (just the request, the answer and any error) for a
quick second opinion. The ▾ next to Copy last has the same two for the latest exchange, plus
**Copy whole chat**, **Copy conversation only**, **Download Markdown**
and **Download JSON** (everything, untruncated).

Keys and tokens are replaced with `[REDACTED]` in every export.

## Subagents

The agent can start specialists in parallel, like Claude Code's Task tool: `reviewer`,
`challenger`, `debugger`, `tester`, `worker` and `fact-checker`, defined in
[`subagents/`](subagents/README.md). Their progress shows live under each reply. Give them
a different model for a second opinion, e.g. `SUBAGENT_MODEL_REVIEWER=gpt-5.5`.

## Network access

The static list in `egress/allowlist.txt` is always allowed. For anything else:

- **The agent asks.** When the proxy refuses a host, the agent calls `request_network_access`
  (GM's own MCP tool, `gm`) with the host and one sentence of why. A card appears bottom-right:
  **Allow** that host, **Allow all of** its domain (every subdomain), or **Deny**. The agent's
  tool call waits for your answer (5 minutes, `NETWORK_REQUEST_TIMEOUT_S`); a denied host isn't
  asked about again for 10 minutes.
- **You allow it yourself** in Settings → Network, which also lists every host refused since GM
  started (one click to allow) and what you've approved (one click to remove).
- Approvals apply within seconds and need no redeploy: squid asks GM about any host not on the
  static list (`egress/gm-approved.sh` → `/internal/egress/check`, answered only for the egress
  container), caching a yes for 15 s. They're kept in `/data/egress-approved.json`, read at
  startup (so an edit to that file, by anyone, does nothing until GM restarts).
- Private and local addresses stay refused whatever is approved. Anything you allow is
  somewhere the agent could send data, so prefer one host over a whole domain.
- Domains you'll always need still belong in `egress/allowlist.txt` (in git, reviewed).

## Files and folders

**Files** (top bar, or the folder icon on a project) browses a project's workspace and adds
local files or whole folders, keeping their structure and skipping `node_modules`, `.git`
and build output. In the chat, the paperclip attaches files and the folder button offers
**Upload a copy** or one of your **linked folders**.

### Copy or link?

| | Copy in | Linked folder |
|---|---|---|
| Use it for | building, storing, anything the agent should change | reviews and analysis of your real files |
| What the agent gets | its own copy in the workspace (read-write) | your folder in place at `/links/<name>`, **read-only, no-exec** |
| Your original | never touched | can't be changed, deleted or encrypted (the kernel refuses writes) |
| How | folder button → Upload a copy, drag and drop, or `copy-in.ps1` for big folders | `link.ps1` on the PC only; GM and the agent can't add, widen or change a link |
| Who can see it | that workspace's chats | **every chat in this GM**; attaching it tells a chat to use it |

```powershell
# copy a big folder in, fast (no browser); -Project "<name>" for a project's workspace
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\copy-in.ps1 -Path "D:\code\roadwolf" -Project "Game Development"

# link a folder read-only: pick it in a dialog, or give the path
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1 -Add "D:\Photos\Horner"
# once: "Link to GM (read-only)" on Explorer's right-click menu for folders (-UninstallMenu removes it)
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1 -InstallMenu
# list links (also re-mounts missing ones), remove one
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1 -List
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\link.ps1 -Remove horner
```

How a link is held shut, layer by layer:

1. The `gm` distro sees no Windows drives (automount off). `link.ps1` mounts just that folder at
   `/srv/gm-links/<name>` with `ro,noexec,nosuid,nodev`, checks that a write fails, and only
   then records it. Only root in the distro can mount, and only you reach root there (from
   Windows). Links come back at boot from `/etc/gm-links`.
2. `gm-agent` gets `/srv/gm-links` at `/links` read-only. Its users are remapped to nobodies in
   the distro, it has no capabilities and can't mount or remount anything.
3. GM reads each link's mount flags from `/proc/self/mountinfo` and never hands a chat a link
   that isn't read-only.
4. Symlinks and junctions inside a linked folder resolve inside the container, so they can't
   lead anywhere else on Windows.
5. Adding or removing a link restarts every GM container that mounts them (about 10 s), so a
   removed link is really gone.

Both scripts refuse whole drives, network paths, Windows/program/app-data folders, your profile
root and GM's own repo (its `.env` holds GM's keys), and stop if the folder holds anything that
looks like keys, passwords or wallets (`.env`, `.ssh`, `*.pem`, `id_*`, `*.kdbx`, wallet and
seed files, browser login stores…; `-AllowSecrets` overrides). The check runs once, so don't
save secrets into a linked folder later. `copy-in.ps1` unpacks as the container's unprivileged
user, never as root, and only accepts plain path characters.

What a link can't protect against: anything the agent reads may be sent to the model it uses,
and to sites on the allowlist or that you approve. Escaping the container would need a flaw in
Docker, WSL or the kernel, so keep Windows and WSL updated. To confirm the container can't talk
to Windows' file server directly (Docker's default seccomp profile blocks `AF_VSOCK`):

```powershell
wsl -d gm --exec docker exec gm-agent python3 -c "import socket; socket.socket(40, socket.SOCK_STREAM)"
# expected: PermissionError / Operation not permitted
```

## GitHub

Set `GITHUB_TOKEN` to a fine-grained token (`github_pat_…`, recommended, limited to the repos
the agent needs) or a classic one (`ghp_…`). git gets it through a credential helper and the
`gh` CLI through `GH_TOKEN`. Settings → Integrations shows who it signs in as.

See [docs/GAPS.md](docs/GAPS.md) for what's still missing compared with other coding agents, and [docs/STORAGE.md](docs/STORAGE.md) for the planned Hippius storage.

## API

All routes need `Authorization: Bearer $APP_TOKEN`.

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/chat` | `{message, model?, engine?, sessionId?}` → `{sessionId, text, tools, errors, usage}` |
| `GET` | `/api/models` | Live SayGM model list (`?refresh=1`) |
| `GET/POST` | `/api/sessions` | List / create (`{engine, model}`) |
| `GET/PATCH/DELETE` | `/api/sessions/:id` | History / rename / delete |
| `POST` | `/api/sessions/:id/messages` | Start a turn. Streams it as SSE (`text`, `thinking`, `tool_start`, `tool_end`, `error`, `done`, `end`); `?stream=0` returns `{turnId}` instead |
| `GET` | `/api/sessions/:id/stream` | Attach to a turn and follow it: `?turnId=` (default: the running one, else the last) and `?from=<seq>` to replay what you missed |
| `POST` | `/api/sessions/:id/abort` | Stop a running turn |
| `GET` | `/api/brand` | Name, logos and colour overrides (public, no token) |
| `GET` | `/api/projects/:id/stored` | What has been mirrored to Hippius for a project |
| `POST` | `/api/stored/:id/restore` | Pull a stored file back into its workspace and verify it |
| `POST` | `/api/stored/:id/retry` | Queue a failed upload again |
| `GET/POST` | `/api/skills`, `/api/skills/sync` | List / re-sync + back up skills to Ditto |
| `GET/POST` | `/api/projects/:id/files` | List a workspace folder (`?dir=`) / upload files (`file`, `path`, `target`); `general` = unfiled workspace |
| `GET/PUT` | `/api/settings` | Current settings (masked) / save UI overrides `{values: {KEY: value or null}}` |
| `GET` | `/api/sessions/:id/export` | Chat export: `?format=md` (default) or `json`; `exchange=last` or an assistant message id; `compact=1` (prompt + reply only); `tools=0`, `activity=0`, `limit=` (chars per tool output) |
| `GET` | `/api/links` | Read-only linked folders (name, path, entries, readOnly, noExec); listed only, never changed |
| `GET` | `/api/network` | Static allowlist, your approvals, pending/recent agent requests, recently blocked hosts |
| `POST` | `/api/network/requests/:id` | Answer an agent's request: `{decision: "host" \| "domain" \| "deny"}` |
| `POST/DELETE` | `/api/network/approved` | Allow `{host, scope: "host" \| "domain"}` / remove `/:host?scope=` |
| `GET` | `/api/activity` | Activity events (`?after=&level=&sessionId=&limit=`) |
| `GET` | `/api/activity/stream` | Live activity (SSE; `?token=` for EventSource) |

```bash
curl -s https://gm.example.com/api/v1/chat \
  -H "Authorization: Bearer $APP_TOKEN" -H 'content-type: application/json' \
  -d '{"message":"What did I decide about the Roadwolf boss fight?","model":"gpt-5"}'
```

## Layout

```
agent/SYSTEM.md        system prompt (memory rules, persona)
skills/<name>/SKILL.md skills, shared by both engines, backed up to Ditto
server/src/
  index.ts             HTTP API + static UI + auth
  agent.ts             turn runner: history, engines, Ditto archive
  engines/opencode.ts  OpenCode engine (SayGM via OpenAI + Anthropic providers)
  engines/claude.ts    Claude Agent SDK engine (SayGM Anthropic endpoint)
  ditto.ts             Ditto MCP client (archive turns, back up skills)
  models.ts            SayGM model list
  activity.ts          activity feed (memory + logs/activity.jsonl, SSE)
  subagents.ts         subagent definitions for both engines
subagents/<name>.md    subagents (reviewer, challenger, debugger, …)
egress/                allowlist proxy for the sandbox
scripts/gm-wsl/        Windows: locked-down WSL distro setup, deploy, start
web/src/               React UI
```

## Adding an engine

Implement `AgentEngine` from `server/src/engines/types.ts` (yield `text` / `tool_*` /
`done` events) and register it in `server/src/agent.ts`. The UI picks it up from
`/api/config`.
