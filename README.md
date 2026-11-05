# BitBob — The Bittensor Builder

_(Formerly "GM Agent" / repo SayGMAgent; renamed 4 Nov 2026.)_

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
- Three small containers (the agent, an allowlist proxy, a localhost-only gateway) and one data folder; reachable by URL with a bearer token
- `POST /api/v1/chat` for scripts and other agents

New here (or a new agent session)? Start with [CLAUDE.md](CLAUDE.md) and [docs/HANDOFF.md](docs/HANDOFF.md).
Agents *using* BitBob (rather than changing it) read [agent-readme.md](agent-readme.md).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the
OpenCode-vs-Agent-SDK proposal.

## Quick start (local)

Requires Node 22.13+ (uses Node's built-in SQLite, so nothing needs compiling).

```bash
git clone https://github.com/tommyhgunz14/BitBob.git
cd BitBob
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
docker compose logs -f bitbob-agent   # or the Activity panel in the UI
docker compose logs -f egress     # every outbound request, allowed or refused
docker compose exec egress squid -k reconfigure   # after editing egress/allowlist.txt (no dropped connections)
docker compose down               # stop
```

Optional limits in `.env`: `BITBOB_CPUS` (default 4), `BITBOB_MEMORY` (default 6g), `BITBOB_PORT`
(default 8787), `BITBOB_DATA_DIR` (default `./data`).

On Windows, use the locked-down WSL distro (below) rather than your everyday Ubuntu.
`npm run dev` still works for UI development, with the agent's shell disabled.

## What runs where

Three layers, from the outside in. Each only sees what the layer outside hands it.

```
Windows  ── D:\github\BitBob (source, .env, git)      ── deploy.ps1 copies code + .env in ──┐
                                                                                                 ▼
WSL distro "bitbob" (no Windows drives, no Windows programs, Docker with userns-remap)
   ~/BitBob   code copy, replaced on every deploy
   ~/bitbob-data      ALL live data (chats, workspaces, uploads, logs)  ── mounted as /data ──┐
                                                                                         ▼
Docker (network "sandbox" is internal: no internet, no LAN, no host)
   bitbob-gateway  socat: 127.0.0.1:8787 on your PC → bitbob-agent:8787 (the only way in)
   bitbob-agent    server + UI + agent engines; runs as uid 1000, read-only filesystem
   bitbob-egress   squid allowlist proxy (the only way out)
```

### Outside Docker: Windows

| What | Where | Notes |
|---|---|---|
| Source code, git history | `D:\github\BitBob` | You edit and commit here. BitBob never sees this folder. |
| Secrets and settings | `D:\github\BitBob\.env` | Never committed (`.gitignore`). Copied into `bitbob` by `deploy.ps1`. |
| Scripts | `scripts\bitbob-wsl\setup.ps1`, `deploy.ps1`, `start.ps1` | One-time setup, ship changes, keep running. |
| Start at login | Startup folder shortcut "BitBob" | Created by `start.ps1 -InstallAtLogin`. |
| The `bitbob` distro's disk | `%LOCALAPPDATA%\BitBob-WSL\disk` | A virtual disk holding everything in the next table. |
| Old data from before the sandbox | `D:\github\BitBob\data` | Copied into `bitbob` once at setup; no longer used. |

### Outside Docker: inside the `bitbob` WSL distro

| What | Where | Notes |
|---|---|---|
| Lockdown | `/etc/wsl.conf` | No drive mounts, no Windows interop, Docker started at boot. |
| Docker Engine | `/etc/docker/daemon.json` | `userns-remap`: container users map to unprivileged IDs here. |
| Deployed code + `.env` | `~/BitBob` | Replaced on each deploy; don't edit here. |
| **Live data** | `~/bitbob-data` | Owned by the remapped container user (mode 700). Read it as root: `wsl -d bitbob -u root`, or `\\wsl.localhost\bitbob\home\<you>\bitbob-data` from an admin tool. |

### Inside Docker

| Container | Image contents | Can write | Network |
|---|---|---|---|
| `bitbob-agent` | Node 22, built server + web UI, OpenCode, Claude Agent SDK, `agent/`, `skills/`, `subagents/`, `tools/`; git, gh, ripgrep, Python, ffmpeg, exiftool, poppler, tesseract | `/data` (= `~/bitbob-data`) and a 1 GB `/tmp` | `sandbox` only; HTTP(S) via `egress` |
| `bitbob-egress` | squid; `egress/allowlist.txt` mounted read-only | nothing persistent | `sandbox` + `outside` |
| `bitbob-gateway` | socat | nothing | `sandbox` + `outside`; publishes 127.0.0.1:8787 |

`bitbob-agent` gets every variable in `.env` plus `HTTPS_PROXY=http://egress:3128`. Inside it,
`HOME`, caches and both engines' state live under `/data`, because the rest of the
filesystem is read-only.

## Where your data goes

Everything BitBob stores is under `/data` in the container (`~/bitbob-data` in the `bitbob` distro):

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
  Still back up `~/bitbob-data` for the database and workspaces (for example
  `wsl -d bitbob -u root -- tar -czf - -C /home/<you> bitbob-data > bitbob-data.tgz`): Hippius holds the
  files you uploaded, not the chats.

## On Windows: the locked-down WSL distro

A normal WSL distro mounts every Windows drive and can launch Windows programs, so it is a
thin wall. `scripts/bitbob-wsl/` creates a separate distro, `bitbob`, with both switched off and
Docker running with user-namespace remapping (a container escape lands as an unprivileged
user that can't mount drives).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\setup.ps1                 # once (uses Docker in your Ubuntu distro to get a clean image)
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\deploy.ps1                # ship code and .env changes, rebuild
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\start.ps1 -InstallAtLogin  # keep BitBob running; start at login
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\start.ps1 -Stop
```

### The desktop app (no PowerShell, no browser tab)

`desktop/` is a small Windows app (Tauri 2) that does the same with buttons: it checks WSL,
the `bitbob` distro, Docker and the containers, runs these scripts with a click and shows their
output, then opens BitBob's UI in its own window once the stack answers, signed in with
`APP_TOKEN` from `.env`. It lives in the tray; closing it leaves BitBob running. Build it once
on the PC (`cd desktop && npm install && npm run tauri build`, needs rustup + VS Build
Tools); see [desktop/README.md](desktop/README.md).

### Backups

Hippius mirrors uploads only. To keep everything else (chats in `agent.db`, projects,
settings), back up the data folder to a file on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\backup.ps1            # to Documents\BitBob backups
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\backup.ps1 -Keep 10   # and keep only the newest 10
```

The file includes any keys you saved in the UI, so keep it private. The script header shows
how to restore.

### Trying a branch before you merge it

A second, isolated BitBob on another port, with its own containers and its own empty data
folder, built from whatever is in your checkout right now. The live stack on 8787 is never
touched.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1            # start on http://localhost:8788
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Logs      # follow its log
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Down      # stop, keep its data
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\test-stack.ps1 -Destroy   # stop and delete its data
```

It uses the same `.env`, so the same access token unlocks it, but its chats, workspaces and
settings are entirely separate (`~/bitbob-data-test` in the distro). `-Port` and `-Name` let you
run more than one.

## Run with Docker (any server)

```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```

State lives in `./data` (or `BITBOB_DATA_DIR`). Put it behind HTTPS (Caddy, nginx or a
Cloudflare Tunnel) before exposing it: the agent can run shell commands in its workspace.

## Keys and settings: `.env` or the UI

`.env` is the base. Keys and settings marked **Edit** in Settings → Configuration (model
keys, Ditto, GitHub, Atlas, 404, Taostats, default models, heritage policy, upload size)
can also be set from the UI. They're saved on the server in `data/settings.local.json`
(mode 600, never in git), override `.env`, and apply immediately: no deploy or restart.
**Use .env** removes an override. Each value shows where it comes from: `.env`,
`set here` or `default`.

Access and sandbox settings (`APP_TOKEN`, `ALLOW_*`, `BITBOB_SANDBOX`, permissions, ports,
paths, proxy) and every service URL can only be changed in `.env` plus a deploy, so a browser
session can't lower the walls or redirect a key to another host. `settings.local.json` lives
in the data folder, which the agent's shell can write, so BitBob reads only the UI-editable keys
from it and ignores (and reports) anything else. The UI can't write your Windows `.env` (the
container can't see Windows, by design); copy a value there yourself if you want it to be the
long-term default.

BitBob's own credentials (SayGM, Ditto, Atlas, 404, Hippius, `APP_TOKEN`) are blanked in every
shell the **OpenCode** engine starts, and any known key that turns up in a tool's output, a
reply, an export or the Ditto archive is replaced with `[REDACTED]`
([`agent/opencode-plugin/bitbob-guard.js`](agent/opencode-plugin/bitbob-guard.js) for OpenCode; the
server redacts again for both engines). Keys meant for the agent (`GITHUB_TOKEN`,
`TAOSTATS_API_KEY`) stay available to it but are masked in output. The **Claude Agent SDK**
engine has no equivalent of bitbob-guard: its shell inherits the SayGM key, and only the server's
redaction stands between it and the chat. This all prevents accidental leaks; it isn't a hard
wall, because the shell runs as the same user as BitBob and can read the server's environment,
`APP_TOKEN` included, and with the token it can call BitBob's own API (approve its own domains,
change UI settings, read chats). That is GAPS.md item 11, the next structural fix: a separate
tool container with no secrets. Until then, treat BitBob as safe against a careless agent, not a
determined one, and use scoped keys where the service offers them.

The page itself is not a way round the proxy: a Content-Security-Policy lets the browser load
images, media and scripts only from BitBob, so a reply or brand file that points at
`https://evil/?<data>` is never fetched. Images in replies are shown as links.

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
with its tool calls, that turn's activity log and a short description of how BitBob is set up,
as Markdown ready to paste into Claude, ChatGPT, Codex or another BitBob chat. **Copy for agent**
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
  (BitBob's own MCP tool, `bitbob`) with the host and one sentence of why. A card appears bottom-right:
  **Allow** that host, **Allow all of** its domain (every subdomain), or **Deny**. The agent's
  tool call waits for your answer (5 minutes, `NETWORK_REQUEST_TIMEOUT_S`); a denied host isn't
  asked about again for 10 minutes.
- **You allow it yourself** in Settings → Network, which also lists every host refused since BitBob
  started (one click to allow) and what you've approved (one click to remove).
- Approvals apply within seconds and need no redeploy: squid asks BitBob about any host not on the
  static list (`egress/bitbob-approved.sh` → `/internal/egress/check`, answered only for the egress
  container), caching a yes for 15 s. They last until BitBob restarts and are deliberately never
  saved: everything in `/data` is writable by the agent's shell, so a saved list could have a
  domain planted in it. Domains you always need go in `egress/allowlist.txt`.
- Private and local addresses stay refused whatever is approved. Anything you allow is
  somewhere the agent could send data, so prefer one host over a whole domain.
- Domains you'll always need still belong in `egress/allowlist.txt` (in git, reviewed).

## Files and folders

**Files** (top bar, or the folder icon on a project) browses a project's workspace, sortable by
name, kind, size or modified time, and shows the folder's real path inside the container and on
the host (copy buttons) so you can open the same place with `wsl -d bitbob`. It adds
local files or whole folders, keeping their structure and skipping `node_modules`, `.git`
and build output. In the chat, the paperclip attaches files and the folder button offers
**Upload a copy** or one of your **linked folders**.

### Copy or link?

| | Copy in | Linked folder |
|---|---|---|
| Use it for | building, storing, anything the agent should change | reviews and analysis of your real files |
| What the agent gets | its own copy in the workspace (read-write) | your folder in place at `/links/<name>`, **read-only, no-exec** |
| Your original | never touched | can't be changed, deleted or encrypted (the kernel refuses writes) |
| How | folder button → Upload a copy, drag and drop, or `copy-in.ps1` for big folders | folder button → **Link a folder from this PC…** (or Settings → Folders): a Windows folder picker opens on the PC and you choose there. Also `link.ps1` |
| Who can see it | that workspace's chats | **every chat in this BitBob**; attaching it tells a chat to use it |

```powershell
# copy a big folder in, fast (no browser); -Project "<name>" for a project's workspace
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\copy-in.ps1 -Path "D:\code\roadwolf" -Project "Game Development"

# link a folder read-only: pick it in a dialog, or give the path
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1 -Add "D:\Photos\Horner"
# once: "Link to BitBob (read-only)" on Explorer's right-click menu for folders (-UninstallMenu removes it)
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1 -InstallMenu
# a folder with secrets: a read-only copy without them (BitBob's own repo always links this way)
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1 -Add "D:\github\BitBob" -Hide
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1 -Refresh bitbob
# list links (also re-mounts missing ones), remove one
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1 -List
powershell -ExecutionPolicy Bypass -File scripts\bitbob-wsl\link.ps1 -Remove horner
```

**Linking with the mouse.** The page can't see your disks and never sends a path. It asks the
**link helper** (`scripts/bitbob-wsl/link-helper.ps1`, started hidden by `start.ps1`, listening on
`http://localhost:8790` only), which opens a Windows folder picker on the PC. Nothing is linked
unless you pick a folder there; if the folder holds keys, `.env` files or wallets, a Windows box
asks how to link it (below). The helper then runs `link.ps1`, so every check below applies. It only
answers BitBob's own page (Origin `http://localhost:8787`/`8788`), and the agent can't reach it at all
(its proxy refuses local addresses). Linking therefore works from the PC BitBob runs on, not from a
phone or another computer.

**Folders that hold secrets** (BitBob's own repo, any project with a `.env`) are linked as a
**filtered copy**: a read-only copy that leaves out `.env` (templates like `.env.example` stay),
keys, wallets, browser login stores, `node_modules`/caches and, for BitBob's repo, `data\` too. The
agent never sees those files, because they aren't there. Hiding files inside a live Windows
mount isn't reliable (Windows names are case-insensitive and have 8.3 short aliases, so a hidden
`.env` could still be opened as `.ENV` or `ENV~1`), which is why it's a copy: the folder is
mounted read-only somewhere only root in the distro can see, copied without the hidden paths,
and unmounted again. The copy changes only when you press **Refresh** (Settings → Folders, or
`link.ps1 -Refresh <name>`), which re-scans the folder for secrets first. Git history in a
linked repo is included, so a secret that was ever committed is still in `.git`.

How a link is held shut, layer by layer:

1. The `bitbob` distro sees no Windows drives (automount off). `link.ps1` mounts just that folder at
   `/srv/bitbob-links/<name>` with `ro,noexec,nosuid,nodev`, checks that a write fails, and only
   then records it. Only root in the distro can mount, and only you reach root there (from
   Windows). Links come back at boot from `/etc/bitbob-links`.
2. `bitbob-agent` gets `/srv/bitbob-links` at `/links` read-only. Its users are remapped to nobodies in
   the distro, it has no capabilities and can't mount or remount anything.
3. BitBob reads each link's mount flags from `/proc/self/mountinfo` and never hands a chat a link
   that isn't read-only.
4. Symlinks and junctions inside a linked folder resolve inside the container, so they can't
   lead anywhere else on Windows.
5. Adding or removing a link restarts every BitBob container that mounts them (about 10 s), so a
   removed link is really gone.

Both scripts refuse whole drives, network paths, Windows/program/app-data folders, your profile
root and BitBob's own repo (its `.env` holds BitBob's keys), and stop if the folder holds anything that
looks like keys, passwords or wallets (`.env`, `.ssh`, `*.pem`, `id_*`, `*.kdbx`, wallet and
seed files, browser login stores…; `-AllowSecrets` overrides). The check runs once, so don't
save secrets into a linked folder later. `copy-in.ps1` unpacks as the container's unprivileged
user, never as root, and only accepts plain path characters.

What a link can't protect against: anything the agent reads may be sent to the model it uses,
and to sites on the allowlist or that you approve. Escaping the container would need a flaw in
Docker, WSL or the kernel, so keep Windows and WSL updated. To confirm the container can't talk
to Windows' file server directly (Docker's default seccomp profile blocks `AF_VSOCK`):

```powershell
wsl -d bitbob --exec docker exec bitbob-agent python3 -c "import socket; socket.socket(40, socket.SOCK_STREAM)"
# expected: PermissionError / Operation not permitted
```

## Capturing documents, photos and books

Phones scan (Microsoft Lens / Adobe Scan / vFlat), a shared cloud folder collects, the PC
syncs it, and it's linked read-only into BitBob; in a project chat, "ingest /links/bitbob-capture"
runs `tools/ingest.mjs`, which copies new scans into `archive/items/`, de-duplicates, reads
dates, OCRs and writes `archive/manifest.md` for the `archive-ingest` skill. The phone-to-BitBob
route (per-device upload-only tokens, tunnel, capture page) is planned in
[docs/CAPTURE.md](docs/CAPTURE.md).

## Moving your Claude.ai projects and chats in

Two routes, both safe to re-run.

**Everything at once**: the account export. On claude.ai go to Settings → Privacy → **Export
data**; Anthropic emails a manifest with links to several zips (`projects-000.zip`,
`conversations-000.zip`, `memories-000.zip`, `frames-000.zip`, `light_metadata-000.zip`).
Download them all into one folder, then:

```powershell
node tools\import-claude-export.mjs "$env:USERPROFILE\Downloads\claude-export" --dry-run   # what would happen
node tools\import-claude-export.mjs "$env:USERPROFILE\Downloads\claude-export"
```

Every project becomes a BitBob project (description, instructions, its docs under
`uploads/claude-import/docs/`, and Claude's memory of the project under
`uploads/claude-import/memory/`); the account-level memory files and your artifacts go to the
general workspace's `uploads/claude-import/`; every conversation becomes a chat with its original
dates and messages. The export doesn't record which project a chat belonged to, so chats arrive
unfiled unless `--project "<name>"` files them all under one; `--since 2026-01-01` skips older
ones; `--projects-only` / `--conversations-only`; `--no-artifacts`. Attachments keep their
extracted text; images are named only. Imported chats have no engine session yet, so the first
message you send in one hands the whole history to the agent as context.

**One project, with Claude's memory files**: ask Claude, in that project, to "export this
project for BitBob". It writes a folder with `project.json`, `docs/` and `memory/` (Claude's
memory files for the project, verbatim), and on the PC:

```powershell
node tools\import-project.mjs claude-export\game-development      # token read from .env
```

It creates the BitBob project (or reuses one with that name), uploads everything to
`uploads/claude-import/` with an `INDEX.md`, and prints the chat message that asks the agent
to seed Ditto from the memory files. Exports hold personal notes: keep them out of git
(`claude-export/` is ignored).

## Ditto: identity, threads, review

**Identity.** Give BitBob its own Ditto agent account instead of your personal key: once, on
your PC, `npx -y --package @heyditto/cli heyditto init --name BitBob --json`, open the
`claimURL` it prints and claim the account as yourself, then put the key it stored
(`~/.config/heyditto/cli/config.json`, or `%APPDATA%\heyditto\cli` on Windows) into `.env` as
`DITTO_API_KEY` (or into the vault via Settings). From then on everything BitBob saves shows in
your graph as the **BitBob** agent thread, labelled as such, and the key in BitBob's config is
BitBob's: revoke it without touching your own. The name is fixed at `init`, so pick it then.

**Threads.** Each BitBob chat is archived into its own Ditto session thread, titled like the chat
(`<project> · <chat title>`), via the `X-Ditto-Session-Id` / `-Name` headers, instead of Ditto's
time-based grouping. The agent's own `save_memory` calls still go through the engine's MCP
connection and are grouped by Ditto; the archive is the per-chat record.

**Main Agent.** The agent is told to ask your Ditto Main Agent (`send_message_to_agent`) for
questions that need judgement across your whole memory rather than one fact.

**Ditto Review.** The `ditto_review` tool on BitBob's own MCP runs Ditto's CLI *on the server*
(with the Ditto key, which the agent's shell never sees) against a clone in the workspace:
working, staged or since-base changes, quick/standard/deep profile, findings back as JSON.
The repo's GitHub origin has to be enabled for Ditto Review in your Ditto workspace and the key
needs review access; until then the tool returns the service's refusal. `verify-changes` and
`git-workflow` ask for it before a commit or PR. The CLI is in the image (`@heyditto/cli`).

## Keys: `.env` and the vault

`.env` is what the stack boots on; it never leaves the PC and is copied into the distro by
`deploy.ps1`. Keys you add later in **Settings → Config** go into the **vault**:
`vault.json` in BitBob's data folder, AES-256-GCM, encrypted with a key BitBob never stores.
The key is made once by the link helper on this PC and kept under `%LOCALAPPDATA%\BitBob\vault.key`,
protected with Windows DPAPI for your Windows user. When you open BitBob on this PC the page
fetches the key from the helper and unlocks the vault on the server (memory only); from a phone
or another machine the vault stays locked and `.env` applies. Why: `settings.local.json` is
readable by the agent's shell (it shares the server's user), so keys saved there were one prompt
injection away from leaking; the vault file is ciphertext to it. The first unlock moves any
secrets still in `settings.local.json` into the vault. Settings → Config shows the vault's state
and a **Lock** / **Unlock from this PC** button; rows show `vault` as their source.

## Opening folders in Explorer

The Files view shows each folder's path inside the container and inside the `bitbob` distro;
**Open in Explorer** opens it on Windows (`\\wsl.localhost\bitbob\…`) through the link helper,
which only opens folders under `bitbob-data`. `start.ps1` makes the data folder traversable for
this; `settings.local.json` and `vault.json` stay owner-only.

## Ditto sync per project

Right-click a project → **Enable Ditto sync** (also a checkbox in Project settings). A ◆ next to
the project shows it is on. Enabling it starts a seed run in its own chat ("Ditto sync ·
<project>"): the agent reads the project's imported Claude material (`uploads/claude-import/`:
docs and memory files, keeping "Tom said" apart from "Claude found") and the workspace docs, and
saves every durable fact, decision and preference to Ditto, merging with what is already there.
From then on, every chat in that project is told that Ditto is the project's record: search it
before answering about the project, and save durable facts at the end of a turn. **Sync to Ditto
now** re-runs the seed (safe: it merges). This is the right way to bring imported projects into
memory, since a chat can only read its own project's workspace.

## QA swarm

**QA swarm** (top bar, in any chat) points up to two *other* models at a repo, folder or file in
the workspace. Each reviews it on its own in the sandbox, read-only, across the areas you tick
(integrity, security/exploitability, efficiency, effectiveness) and writes a report with
evidence; then each reads the other's report and has to agree, refute or admit it can't tell,
with evidence; then the chat's own model, the primary handler, weighs both rounds, checks any
disputed point itself, and replies in the chat with a per-reviewer summary, a ranked table of
verified issues and an overall recommendation (use as is / fix first / don't use). The
reviewers' chats are in the sidebar as "QA swarm · …" and in the activity log, so their working
is inspectable and exportable. Different model families catch different things; two reviewers
from one family mostly share blind spots. `POST /api/swarm` starts one from outside.

## Repositories

**Repos** (top bar), the branch icon on a project, or right-click a project → **Repositories**
lists every git clone in that workspace: current branch, what's uncommitted, ahead/behind its
upstream, last commit, remote, branches (local, and remote on request), stashes, and a summary
of the uncommitted changes. **Browse files** opens the Files view at that clone. The view only
reads; every other button (explain changes, fetch and compare, pull, review and propose a
commit, new branch, switch, compare) puts a request in the chat for the agent, so git actions
run in the sandbox where you can see them and the reviewer can check them.

## GitHub

Set `GITHUB_TOKEN` to a fine-grained token (`github_pat_…`, recommended, limited to the repos
the agent needs) or a classic one (`ghp_…`). git gets it through a credential helper and the
`gh` CLI through `GH_TOKEN`. Settings → Integrations shows who it signs in as.

See [docs/GAPS.md](docs/GAPS.md) for what's still missing compared with other coding agents, and [docs/STORAGE.md](docs/STORAGE.md) for the planned Hippius storage.

## API

Every `/api/*` route needs `Authorization: Bearer $APP_TOKEN`, except `GET /api/health` and
`GET /api/brand` (+ `/api/brand/asset/:file`), which the login screen needs before there is a
token. Only the two live streams (`GET /api/activity/stream`, `GET /api/sessions/:id/stream`)
also accept the token as `?token=`, because EventSource can't send headers; every other route
refuses it there. That is fine on localhost and is due to move to a header or cookie before BitBob is
put behind a tunnel (docs/CLIENTS.md 0.3). `/internal/egress/check` answers only the egress
container, and `/mcp/bitbob` only the engines (a token minted at startup).

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/chat` | `{message, model?, engine?, sessionId?, projectId?, attachments?, plan?}` → `{sessionId, turnId, text, tools, errors, usage}` |
| `GET` | `/api/health` | `{ok: true}` (public) |
| `GET` | `/api/config` | Engines, default engine and model, Ditto on/off |
| `GET` | `/api/status` | Live SayGM / Ditto / sandbox checks (no model tokens spent) |
| `GET` | `/api/debug` | Tries each SayGM API shape and logs which fail |
| `GET` | `/api/models` | Live SayGM model list (`?refresh=1`) |
| `POST` | `/api/models/refresh` | Re-read the model list and reload OpenCode |
| `GET/PUT` | `/api/settings` | Current settings (masked) / save UI overrides `{values: {KEY: value or null}}` |
| `GET/POST` | `/api/sessions` | List / create (`{engine, model, projectId?}`) |
| `GET/PATCH/DELETE` | `/api/sessions/:id` | History / rename or move (`{title?, projectId?}`) / delete |
| `POST` | `/api/sessions/:id/messages` | Start a turn. Streams it as SSE (`text`, `thinking`, `tool_start`, `tool_end`, `error`, `done`, `end`); `?stream=0` returns `{turnId}` instead |
| `GET` | `/api/sessions/:id/stream` | Attach to a turn and follow it: `?turnId=` (default: the running one, else the last) and `?from=<seq>` to replay what you missed |
| `POST` | `/api/sessions/:id/abort` | Stop a running turn |
| `POST` | `/api/sessions/:id/files` | Upload attachments for a chat (multipart `file`, up to 20) |
| `GET` | `/api/sessions/:id/export` | Chat export: `?format=md` (default) or `json`; `exchange=last` or an assistant message id; `compact=1` (prompt + reply only); `tools=0`, `activity=0`, `limit=` (chars per tool output) |
| `GET/POST` | `/api/projects` | List / create a project |
| `PATCH/DELETE` | `/api/projects/:id` | Update (name, instructions, colour, integrations) / delete |
| `GET/POST` | `/api/projects/:id/files` | List a workspace folder (`?dir=`) / upload files (`file`, `path`, `target`); `general` = unfiled workspace |
| `POST` | `/api/import/conversations` | Write chats into history (`{source, projectId?, conversations:[{id,title,createdAt,messages:[{role,content,createdAt}]}]}`); ids are `<source>-<id>`, so repeats are skipped |
| `POST/GET` | `/api/swarm`, `/api/swarm/:id` | Start a QA swarm (`{sessionId, target, models[1..2], focus?}`) / its progress; reviewer chats are ordinary sessions |
| `POST` | `/api/projects/:id/ditto-sync` | Start a Ditto seed/refresh run for the project in its own chat; `PATCH /api/projects/:id {dittoSync}` turns the standing sync on/off |
| `GET/POST` | `/api/vault`, `/api/vault/unlock {key}`, `/api/vault/lock` | Vault state; unlock with the 64-hex key (migrates secrets out of settings.local.json); lock |
| `GET` | `/api/projects/:id/repos` | Git clones in the workspace: branch, status, ahead/behind, branches, last commit (read-only) |
| `GET` | `/api/projects/:id/repos/diff` | `?repo=<path>` uncommitted-changes stat; `&base=<ref>` compares base...HEAD |
| `GET` | `/api/projects/:id/stored` | What has been mirrored to Hippius for a project |
| `POST` | `/api/stored/:id/restore` | Pull a stored file back into its workspace and verify it |
| `POST` | `/api/stored/:id/retry` | Queue a failed upload again |
| `POST` | `/api/storage/key` | Generate a Hippius encryption key (shown once) |
| `GET` | `/api/integrations`, `/api/integrations/status` | Atlas / 404 / GitHub: configuration, and live checks |
| `GET` | `/api/ditto/tools` | The tools Ditto's MCP server offers |
| `GET/POST` | `/api/skills`, `/api/skills/sync` | List / re-sync + back up skills to Ditto |
| `GET` | `/api/brand` | Name, logos and colour overrides (public) |
| `GET` | `/api/links` | Read-only linked folders (name, path, entries, readOnly, noExec); listed only, never changed |
| `GET` | `/api/network` | Static allowlist, your approvals, pending/recent agent requests, recently blocked hosts |
| `POST` | `/api/network/requests/:id` | Answer an agent's request: `{decision: "host" \| "domain" \| "deny"}` |
| `POST/DELETE` | `/api/network/approved` | Allow `{host, scope: "host" \| "domain"}` / remove `/:host?scope=` |
| `GET` | `/api/activity` | Activity events (`?after=&level=&sessionId=&limit=`) |
| `GET` | `/api/activity/stream` | Live activity (SSE; `?token=` for EventSource) |

```bash
curl -s https://bitbob.example.com/api/v1/chat \
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
scripts/bitbob-wsl/        Windows: locked-down WSL distro setup, deploy, start
web/src/               React UI
```

## Adding an engine

Implement `AgentEngine` from `server/src/engines/types.ts` (yield `text` / `tool_*` /
`done` events) and register it in `server/src/agent.ts`. The UI picks it up from
`/api/config`.
