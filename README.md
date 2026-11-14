# BitBull — The Bittensor Builder

A personal agent on top of **[SayGM](https://saygm.com)** (one key, many models, switch
any time), with **[Ditto](https://heyditto.ai)** as long-term memory, two pluggable agent
engines (**OpenCode** and the **Claude Agent SDK**) and its own web UI.

- Chat UI with streaming, tool-call view, browser tools, per-message model switching
- Turns run on the server, not in your tab: close it, sleep the laptop, come back, and the
  chat picks up where it left off
- Light and dark, with colour schemes for the background and sidebar (Settings → Appearance), and
  white-labelled from one `brand.json` — name, logo and every colour
- **QA Hound**: unleash multiple LLMs on a repo, folder or file to review it, challenge each other
  and summarise a verdict and recommendations
- Engine per chat: **OpenCode** (native for every model) or **Claude Agent SDK**
- Ditto MCP wired into the agent + every turn and skill archived to Ditto whenever you need it
- Skills in `/skills`, versioned in Git, shared by both engines
- Sandboxed Docker containers (the agent, an allowlist proxy, a localhost-only gateway) and one
  data folder; reachable by URL with a bearer token
- Import existing conversations, projects and data from your existing coding agents
- `POST /api/v1/chat` for scripts and other agents
- **Which model for this?** (three picks with pros, cons and cost), a model picker with maker
  filters and your own response speeds; **Connect Ditto** for Ditto Router models next to SayGM's,
  with your Ditto memory and connected apps as the agent's tools, and your provider keys (GM,
  OpenRouter, OpenAI, …) kept in Ditto instead of `.env`
- **Voice**: talk to it and hear it answer, push-to-talk from anywhere, hands-free
- Show it a window or send it a web page (browser extension), get every file a reply made with one
  click, archive and bulk-tidy chats
- Bittensor services wired in: Taostats, Atlas, 404 (3D as code), Hippius storage, Ditto memory
  and Ditto Review

Installing for the first time? The step-by-step guide for Windows, Mac and Linux is at
**[bitbull.tech/guide](https://www.bitbull.tech/guide/getting-started)**, or paste this into the AI
agent you already use: *Set up BitBull for me. Fetch https://www.bitbull.tech/get-started and
follow it.*

New here (or a new agent session)? Start with [CLAUDE.md](CLAUDE.md) and [docs/HANDOFF.md](docs/HANDOFF.md).
Agents *using* BitBull (rather than changing it) read [agent-readme.md](agent-readme.md).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the
OpenCode-vs-Agent-SDK proposal.

## Quick start (local)

Requires Node 22.13+ (uses Node's built-in SQLite, so nothing needs compiling).

```bash
git clone https://github.com/bitbull-tech/BitBull.git
cd BitBull
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
docker compose up -d              # UI + API on http://localhost:8787 (this computer only)
docker compose logs -f bitbull-agent   # or the Activity panel in the UI
docker compose logs -f egress     # every outbound request, allowed or refused
docker compose exec egress squid -k reconfigure   # after editing egress/allowlist.txt (no dropped connections)
docker compose down               # stop
```

Optional limits in `.env`: `BITBULL_CPUS` (default 4), `BITBULL_MEMORY` (default 6g), `BITBULL_PORT`
(default 8787), `BITBULL_DATA_DIR` (default `./data`).

On Windows, use the locked-down WSL distro (below) rather than your everyday Ubuntu; on a Mac, the
bitbull VM ("On a Mac", below).
`npm run dev` still works for UI development, with the agent's shell disabled.

## What runs where

Three layers, from the outside in. Each only sees what the layer outside hands it.

```
Windows  ── C:\code\BitBull (source, .env, git)        ── deploy.ps1 copies code + .env in ──┐
                                                                                                 ▼
WSL distro "bitbull" (no Windows drives, no Windows programs, Docker with userns-remap)
   ~/BitBull   code copy, replaced on every deploy
   ~/bitbull-data      ALL live data (chats, workspaces, uploads, logs)  ── mounted as /data ──┐
                                                                                         ▼
Docker (network "sandbox" is internal: no internet, no LAN, no host)
   bitbull-gateway  socat: 127.0.0.1:8787 on your PC → bitbull-agent:8787 (the only way in)
   bitbull-agent    server + UI + agent engines; runs as uid 1000, read-only filesystem
   bitbull-egress   squid allowlist proxy (the only way out)
```

### Outside Docker: Windows

| What | Where | Notes |
|---|---|---|
| Source code, git history | your BitBull folder (e.g. `C:\code\BitBull`) | You edit and commit here. BitBull never sees this folder. |
| Secrets and settings | `.env` in that folder | Never committed (`.gitignore`). Copied into `bitbull` by `deploy.ps1`. |
| Scripts | `scripts\bitbull-wsl\setup.ps1`, `deploy.ps1`, `start.ps1` | One-time setup, ship changes, keep running. |
| Start at login | Startup folder shortcut "BitBull" | Created by `start.ps1 -InstallAtLogin`. |
| The `bitbull` distro's disk | `%LOCALAPPDATA%\BitBull-WSL\disk` | A virtual disk holding everything in the next table. |
| Old data from before the sandbox | `data\` in that folder | Copied into `bitbull` once at setup; no longer used. |

### Outside Docker: inside the `bitbull` WSL distro

| What | Where | Notes |
|---|---|---|
| Lockdown | `/etc/wsl.conf` | No drive mounts, no Windows interop, Docker started at boot. |
| Docker Engine | `/etc/docker/daemon.json` | `userns-remap`: container users map to unprivileged IDs here. |
| Deployed code + `.env` | `~/BitBull` | Replaced on each deploy; don't edit here. |
| **Live data** | `~/bitbull-data` | Owned by the remapped container user (mode 700). Read it as root: `wsl -d bitbull -u root`, or `\\wsl.localhost\bitbull\home\<you>\bitbull-data` from an admin tool. |

### Inside Docker

| Container | Image contents | Can write | Network |
|---|---|---|---|
| `bitbull-agent` | Node 22, built server + web UI, OpenCode, Claude Agent SDK, `agent/`, `skills/`, `subagents/`, `tools/`; git, gh, ripgrep, Python, ffmpeg, exiftool, poppler, tesseract | `/data` (= `~/bitbull-data`) and a 1 GB `/tmp` | `sandbox` only; HTTP(S) via `egress` |
| `bitbull-egress` | squid; `egress/allowlist.txt` mounted read-only | nothing persistent | `sandbox` + `outside` |
| `bitbull-gateway` | socat | nothing | `sandbox` + `outside`; publishes 127.0.0.1:8787 |

`bitbull-agent` gets every variable in `.env` plus `HTTPS_PROXY=http://egress:3128`. Inside it,
`HOME`, caches and both engines' state live under `/data`, because the rest of the
filesystem is read-only.

## Where your data goes

Everything BitBull stores is under `/data` in the container (`~/bitbull-data` in the `bitbull` distro):

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
  and indexed in Ditto. Set it up in Settings → Integrations → Hippius storage, or in
  `.env`; see [docs/STORAGE.md](docs/STORAGE.md). With `STORAGE_MIRROR=off`, nothing is sent.
  Still back up `~/bitbull-data` for the database and workspaces (for example
  `wsl -d bitbull -u root -- tar -czf - -C /home/<you> bitbull-data > bitbull-data.tgz`): Hippius holds the
  files you uploaded, not the chats.

## On Windows: the locked-down WSL distro

A normal WSL distro mounts every Windows drive and can launch Windows programs, so it is a
thin wall. `scripts/bitbull-wsl/` creates a separate distro, `bitbull`, with both switched off and
Docker running with user-namespace remapping (a container escape lands as an unprivileged
user that can't mount drives).

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\setup.ps1                 # once (uses Docker in your Ubuntu distro to get a clean image)
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\deploy.ps1                # ship code and .env changes, rebuild
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\start.ps1 -InstallAtLogin  # keep BitBull running; start at login
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\start.ps1 -Stop
```

### The desktop app (no PowerShell, no browser tab)

`desktop/` is a small Windows and macOS app (Tauri 2) that does the same with buttons: it checks WSL,
the `bitbull` distro, Docker and the containers, runs these scripts with a click and shows their
output, then opens BitBull's UI in its own window once the stack answers, signed in with
`APP_TOKEN` from `.env`. It also keeps the link helper running (folder picker, Open in Explorer,
vault key), registers the push-to-talk shortcut, and its Checks re-run every few seconds (or
**Re-check**). It lives in the tray; closing it leaves BitBull running; **Stop BitBull and quit**
stops the stack too. Build it once
on the PC (`cd desktop && npm install && npm run tauri build`, needs rustup + VS Build
Tools); see [desktop/README.md](desktop/README.md).

### Backups

Hippius mirrors uploads only. To keep everything else (chats in `agent.db`, projects,
settings), back up the data folder to a file on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\backup.ps1            # to Documents\BitBull backups
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\backup.ps1 -Keep 10   # and keep only the newest 10
```

The file includes any keys you saved in the UI, so keep it private. The script header shows
how to restore.

### Trying a branch before you merge it

A second, isolated BitBull on another port, with its own containers and its own empty data
folder, built from whatever is in your checkout right now. The live stack on 8787 is never
touched.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\test-stack.ps1            # start on http://localhost:8788
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\test-stack.ps1 -Logs      # follow its log
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\test-stack.ps1 -Down      # stop, keep its data
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\test-stack.ps1 -Destroy   # stop and delete its data
```

It uses the same `.env`, so the same access token unlocks it, but its chats, workspaces and
settings are entirely separate (`~/bitbull-data-test` in the distro). `-Port` and `-Name` let you
run more than one.

## On a Mac

macOS 13 (Ventura) or later, Apple Silicon or Intel. The same three containers as on Windows run
in a Linux VM; `scripts/bitbull-mac/` does what `scripts/bitbull-wsl/` does there.

**One command** (paste into Terminal) is the whole install: it installs Homebrew and git if
needed, downloads BitBull to `~/BitBull`, creates `.env` with a strong `APP_TOKEN`, sets up and
starts BitBull, installs the **BitBull app** from the latest release into Applications and opens
it, signed in (BitBull in its own window, with a menu-bar icon). If the app can't be downloaded
it opens in your browser instead, also signed in; `-- --browser` after the command skips the app. It asks nothing, except your Mac
password once if Homebrew has to be installed. BitBull's first screen then asks for the two things
only you have: your SayGM key (pasted there) and Ditto (a sign-in, nothing to copy). Run it again
to update; it keeps your settings.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/bitbull-tech/BitBull/main/scripts/bitbull-mac/install.sh)"
```

Or by hand, from the `BitBull` folder:

| To | Run |
| --- | --- |
| Create your settings, then fill in `APP_TOKEN`, `SAYGM_API_KEY`, `DITTO_API_KEY` | `cp .env.example .env` |
| Set up once: Colima VM "bitbull", first build, start | `bash scripts/bitbull-mac/setup.sh` |
| …or use the Docker Desktop / OrbStack you already run | `bash scripts/bitbull-mac/setup.sh --runtime docker` |
| Ship code and `.env` changes, rebuild | `bash scripts/bitbull-mac/deploy.sh` |
| Keep BitBull running; start it (and the app) at login | `bash scripts/bitbull-mac/start.sh --install-at-login` |
| Stop | `bash scripts/bitbull-mac/start.sh --stop` |
| Back up to `~/Documents/BitBull backups` | `bash scripts/bitbull-mac/backup.sh --keep 10` |

**Terminal on a Mac.** Its default shell is zsh, which treats `#` in a pasted line as text, not a
comment, so paste commands without anything after them. Always start the scripts with `bash …`
(they are written for the bash 3.2 macOS ships). On Apple Silicon, Homebrew lives in
`/opt/homebrew`: if `brew` isn't found after installing it, run
`eval "$(/opt/homebrew/bin/brew shellenv)"` (the installer above adds this to `~/.zprofile` for
you). `.env` is hidden in Finder (⌘⇧. shows hidden files); edit it with
`nano .env` rather than TextEdit, which can turn quotes into “smart” quotes.

- **The VM.** By default BitBull gets its own Colima VM (installed with Homebrew if missing), which
  can only see BitBull's folder, `~/Library/Application Support/BitBull`: the deployed code
  (`app/`), the data (`data/`, `/data` in the container) and linked folders (`links/`). The rest of
  your Mac is not shared into it. With `--runtime docker` the containers run in your existing
  engine instead, alongside whatever else it runs.
- **Linked folders are copies.** Windows mounts a linked folder read-only; on a Mac the link helper
  copies it into `links/` (leaving out keys and wallets unless you say otherwise) and the agent
  reads the copy. Press **Refresh** in Settings → Folders after changing the original.
- **The link helper is the app.** Linking folders, Open in Finder and unlocking the vault go
  through the BitBull app (it stays in the menu bar); the vault key is kept in your login Keychain.
- **The app.** The same launcher as on Windows, built as a universal `.dmg` by the `macos` GitHub
  workflow and attached to each `v*` release as `BitBull-macos.dmg`, which is what the installer
  downloads. Ad-hoc signed, not notarised: if macOS refuses the first launch, right-click
  BitBull → Open.

## Run with Docker (any server)

```bash
cp .env.example .env   # fill it in
docker compose up -d   # pulls ghcr.io/bitbull-tech/bitbull and ...-egress; nothing is built here
```

Pick a version with `BITBULL_TAG` (a published release, e.g. `1.2.3`); the default is `latest`,
which follows `main`. To build the images from this checkout instead — what you want when you
are changing BitBull itself — add the development override:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.dev.yml docker compose up -d --build
```

State lives in `./data` (or `BITBULL_DATA_DIR`). Put it behind HTTPS (Caddy, nginx or a
Cloudflare Tunnel) before exposing it: the agent can run shell commands in its workspace.

## Keys and settings: `.env` or the UI

`.env` is the base. Keys and settings marked **Edit** in Settings can also be set from the UI:
the outside services (SayGM, Ditto, GitHub, Taostats, Atlas, 404, Hippius) under
**Integrations**, one card each with its live status; BitBull's own workings (default engine and
models, upload size, the vault, skills and subagents) under **Configuration**.
**Status** shows every service at a glance. They're saved on the server in `data/settings.local.json`
(mode 600, never in git), override `.env`, and apply immediately: no deploy or restart.
**Use .env** removes an override. Each value shows where it comes from: `.env`,
`set here` or `default`.

Access and sandbox settings (`APP_TOKEN`, `ALLOW_*`, `BITBULL_SANDBOX`, permissions, ports,
paths, proxy) and every service URL can only be changed in `.env` plus a deploy, so a browser
session can't lower the walls or redirect a key to another host. `settings.local.json` lives
in the data folder, which the agent's shell can write, so BitBull reads only the UI-editable keys
from it and ignores (and reports) anything else. The UI can't write your Windows `.env` (the
container can't see Windows, by design); copy a value there yourself if you want it to be the
long-term default.

BitBull's own credentials (SayGM, Ditto, Atlas, Hippius, `APP_TOKEN`) are blanked in every
shell the **OpenCode** engine starts, and any known key that turns up in a tool's output, a
reply, an export or the Ditto archive is replaced with `[REDACTED]`
([`agent/opencode-plugin/bitbull-guard.js`](agent/opencode-plugin/bitbull-guard.js) for OpenCode; the
server redacts again for both engines). Keys meant for the agent (`GITHUB_TOKEN`,
`TAOSTATS_API_KEY`, `FOUR04_MODEL_KEY`) stay available to it but are masked in output. The **Claude Agent SDK**
engine has no equivalent of bitbull-guard: its shell inherits the SayGM key, and only the server's
redaction stands between it and the chat. This all prevents accidental leaks; it isn't a hard
wall, because the shell runs as the same user as BitBull and can read the server's environment,
`APP_TOKEN` included, and with the token it can call BitBull's own API (approve its own domains,
change UI settings, read chats). That is GAPS.md item 11, the next structural fix: a separate
tool container with no secrets. Until then, treat BitBull as safe against a careless agent, not a
determined one, and use scoped keys where the service offers them.

The page itself is not a way round the proxy: a Content-Security-Policy lets the browser load
images, media and scripts only from BitBull, so a reply or brand file that points at
`https://evil/?<data>` is never fetched. Images in replies are shown as links.

## Help and the user guide

The **?** button at the bottom of the sidebar opens **Help**: this guide, page by page, and the
system map, with a help chat beside it. Ask how to do something under **Ask BitBull** and the
answer appears there, taken from the guide (the `bitbull-guide` skill reads the same pages from
`help/`), with a link to the page it came from. Help remembers where you were: close it to try a
suggestion and the page, your question and the conversation are there when you open it again.
**Open as a chat** carries the conversation on in the main window, and you can also just ask in
any chat: "how do I link a folder?" works the same way.

## Schedules

**Schedules** (top bar) runs a prompt on its own at set times: every weekday at 08:00, every two
hours, Mondays and Thursdays at 18:30. Each schedule is a dedicated agent with its own chat
(⏰ and its name), where every run lands, so each run can build on the last and you can read or
reply to any of them. Put it in a project and it works with that project's files, instructions
and `TEAM.md`, so a team can run on a timetable.

Nobody is watching a scheduled run, and it is told so: anything that publishes, sends, deletes,
spends or can't be undone is prepared and listed under **Waiting for your approval** in its chat,
for you to approve there. A run never starts while the previous one is still going, the shortest
interval is 15 minutes, and times follow your timezone across daylight-saving changes. Runs
happen while BitBull is running; a run missed while it was off happens once when it starts again.
**Run now** starts one straight away. A cheap, fast model is usually enough.

## Telegram

Message BitBull from your phone, and get scheduled results there, through a Telegram bot that is
yours alone. It is private and personal: the bot answers one Telegram account, yours, in its
one-to-one chat. Everyone else, and every group, is ignored without a reply.

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot` and follow it. It
   gives you a token that looks like `123456789:AA…`.
2. In BitBull: **Settings → Integrations → Telegram**. Paste the token in **Bot token** and save.
3. Press **Pair my Telegram**, then open your bot from the button shown and press **Start** (or
   send the bot the one-time code). The bot now answers you and nobody else.

Nothing has to reach your computer from the internet: BitBull calls out to Telegram, so there is
no port to open and no tunnel.

Send the bot any text and BitBull runs it and replies. `/new` starts a fresh chat, `/stop` stops
what it is doing, `/model` shows which model the chat uses and `/model deepseek flash` changes
it (`/models claude` lists what matches a word), `/help` lists these. A new Telegram chat starts
on your default model (Settings → Configuration), not on whichever model a chat on screen uses. The conversation is the **Telegram** chat in BitBull's
sidebar, so you can read it or carry on from either side. On a schedule, tick **Send each
result to my Telegram** to get every run's summary on your phone.

Nobody is at the BitBull screen when a message comes in by phone, so anything that publishes,
sends, deletes or spends is prepared and left for your approval in BitBull, and requests that
need a click there (network access, for one) wait for you. Text only for now: no photos, voice
notes or files.

Two things to know. Bot chats are not end-to-end encrypted, so Telegram can read what passes
through: don't send secrets that way. And whoever can use your Telegram account can talk to your
BitBull, so turn on Telegram's two-step verification. How pairing is protected, the network
opening it needs, and how to switch it off are in [docs/TELEGRAM.md](docs/TELEGRAM.md).

## Leadpoet: lead generation

[Leadpoet](https://leadpoet.com) is Bittensor subnet 71: it finds companies and contacts that
fit your ideal customer, with the evidence for each, and writes and sends email and LinkedIn
outreach. Connected, BitBull can plan and run a campaign with it: write the customer profile,
request leads, review them, draft the sequences, build the campaign and report on replies.

1. **Settings → Integrations → Leadpoet → Connect Leadpoet.** Sign in with your Leadpoet account
   and approve; there is no key to paste.
2. In the project you run campaigns from, open project settings and tick **Leadpoet**.
3. Ask: "Plan a campaign to get us ten meetings with heads of logistics at UK retailers."

You choose what BitBull may do when you connect: look only, plan and prepare (the default), or
also send. With sending off, BitBull drafts everything and you press send in Leadpoet. Lead
requests spend Leadpoet credits, so the agent shows the plan and the cost and waits for your
yes; and in scheduled runs or over Telegram it only reads and drafts. Your Leadpoet sign-in
stays on the server and is never given to the agent. More in
[docs/LEADPOET.md](docs/LEADPOET.md).

## Long pastes become attachments

Paste more than about a screenful of text into the message box (2,500 characters or 50 lines) and
it is attached as **Pasted text** instead of filling the conversation. The model still gets every
word, in the same message. Click the attachment to read it again, before or after sending, or to
put it back into the message as typed text. **Search chats** in the sidebar looks through what
was said and what was pasted, not only titles, and shows the matching words under the chat.

## Usage

The bar-chart button at the bottom of the sidebar opens **Usage**: estimated spend per day (hover
a day to see which models it went on) and per model, with replies and tokens, over 7, 30 or 90
days. The figures are BitBull's own estimates from SayGM's live prices at the time of each
reply; your SayGM usage page is the bill.

At the top are your balances, read with the keys BitBull already holds (nothing to sign in to):
your **SayGM balance**, and for **Ditto Router** what BitBull's endpoint spent in the last 30
days and what is left under its spend cap if it has one. Ditto has no call for an account's
credit balance, so that isn't shown. **Refresh balances** asks again; otherwise they are kept
for a minute.

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

## Updates and compatibility notices

BitBull depends on SayGM and Ditto, which change on their own schedule. A banner above the chat
tells you when one of them has changed something BitBull relies on, is retiring part of its API,
has stopped offering your default model, or no longer accepts a key (a Connect Ditto sign-in lasts
three months), and when a newer BitBull is out. Notices are also written to Activity, and can be
dismissed per computer. The server checks shortly after it starts and every six hours.

**To update.** In the BitBull app, open the launcher (from the menu-bar or tray icon) and press
**Update**: it gets the latest BitBull from GitHub and rebuilds. On a Mac it also brings the app
itself up to the latest release and restarts it when the update has finished. Your chats, files and settings
are never touched. The same from a terminal, in your BitBull folder:

| On | Run |
| --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\update.ps1` |
| Mac | `bash scripts/bitbull-mac/update.sh` |
| Linux and servers | `git pull` then `docker compose up -d --build` |

The launcher's **Version** row compares what is running with your copy of the code on this
computer, not with GitHub, so "same as your copy" can still be behind: **Update** is what fetches
anything newer. On a Mac, `bash scripts/bitbull-mac/app.sh` installs or updates just the app; if the app is open
it is asked to quit, replaced and reopened. **Quitting the app** (⌘Q, or Quit on its Dock or
menu-bar icon) closes only the app: BitBull keeps running, and clicking the Dock icon brings its
window back. On Windows a new app is on the
[releases page](https://github.com/bitbull-tech/BitBull/releases/latest).

What is checked, and how maintainers publish a notice to every install: [docs/COMPAT.md](docs/COMPAT.md).

## Make it yours (white-labelling)

Name, tagline, logos and every colour come from `brand.json` in the data folder, with the
image files in `brand/` beside it. Edit it and reload the page — nothing is rebuilt or
deployed. `docs/brand.example.json` is a starting point and
[docs/BRANDING.md](docs/BRANDING.md) lists every token you can override. Settings →
Appearance shows what is in force.

## Export a chat

One click: **Copy last** in the top bar copies your latest request and the agent's reply,
with its tool calls, that turn's activity log and a short description of how BitBull is set up,
as Markdown ready to paste into Claude, ChatGPT, Codex or another BitBull chat. **Copy for agent**
under any reply does the same for that exchange.

Under each reply, **Copy for agent: full · prompt + reply** copies that exchange either
way; **prompt + reply** is the short form (just the request, the answer and any error) for a
quick second opinion. The ▾ next to Copy last has the same two for the latest exchange, plus
**Copy whole chat**, **Copy conversation only**, **Download Markdown**
and **Download JSON** (everything, untruncated).

Keys and tokens are replaced with `[REDACTED]` in every export.

## Archive

Finished with a project or a chat but don't want to delete it? **Archive** it: the archive
button on a project row (or right-click → Archive project), or **⋯ → Archive** on a chat. It moves
into the collapsed **Archive** section at the bottom of the sidebar, a project with all its chats.
Nothing is deleted or changed; archived chats still open, still turn up in search, and
**Unarchive** puts them back where they were.

**Tidying in bulk:** **Select** (by the Chats heading, or **Select…** in a chat's right-click menu)
puts a tick box on every chat; then Archive, Move or Delete them together. Right-click any chat for
its menu. A chat that never got a message isn't listed and is cleared out after an hour.

## Subagents

The agent can start specialists in parallel, like Claude Code's Task tool: `reviewer`,
`challenger`, `debugger`, `tester`, `worker` and `specialist`, defined in
[`subagents/`](subagents/README.md). Their progress shows live under each reply. Give them
a different model for a second opinion, e.g. `SUBAGENT_MODEL_REVIEWER=gpt-5.5`.

Each has a **contract**: what it owns, what its brief must contain, what it returns, when it
stops to ask you (its report then starts with `ESCALATE:` and BitBull puts the question to you),
and when it is done. That keeps their work from overlapping and their handoffs predictable.

**Agent teams.** Choose **Build an agent team** on a project's home screen (or just ask). BitBull
asks a few questions, recommends one use case, and designs a team of three to five roles with a
workflow, review checkpoints, the points where it must ask you (publishing, sending, deleting,
spending), a short test plan and a 7-day launch plan. Once you approve it, it is saved as
`TEAM.md` in the project, and from then on work you ask for there runs through the team. Each
role runs on one of the subagents above, so it keeps their limits: read-only roles can't change
anything. The `team-architect` skill holds the method.

## Network access

The static list in `egress/allowlist.txt` is always allowed. For anything else:

- **The agent asks.** When the proxy refuses a host, the agent calls `request_network_access`
  (BitBull's own MCP tool, `bitbull`) with the host and one sentence of why. A card appears bottom-right:
  **Allow** that host, **Allow all of** its domain (every subdomain), or **Deny**. The agent's
  tool call waits for your answer (5 minutes, `NETWORK_REQUEST_TIMEOUT_S`); a denied host isn't
  asked about again for 10 minutes.
- **You allow it yourself** in Settings → Network, which also lists every host refused since BitBull
  started (one click to allow) and what you've approved (one click to remove).
- Approvals apply within seconds and need no redeploy: squid asks BitBull about any host not on the
  static list (`egress/bitbull-approved.sh` → `/internal/egress/check`, answered only for the egress
  container), caching a yes for 15 s. They last until BitBull restarts and are deliberately never
  saved: everything in `/data` is writable by the agent's shell, so a saved list could have a
  domain planted in it. Domains you always need go in `egress/allowlist.txt`.
- Private and local addresses stay refused whatever is approved. Anything you allow is
  somewhere the agent could send data, so prefer one host over a whole domain.
- Domains you'll always need still belong in `egress/allowlist.txt` (in git, reviewed).

## Files and folders

**Files** (top bar, or the folder icon on a project) browses a project's workspace, sortable by
name, kind, size or modified time, and shows the folder's real path inside the container and on
the host (copy buttons) so you can open the same place with `wsl -d bitbull`. It adds
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
| Who can see it | that workspace's chats | **every chat in this BitBull**; attaching it tells a chat to use it |

```powershell
# copy a big folder in, fast (no browser); -Project "<name>" for a project's workspace
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\copy-in.ps1 -Path "D:\code\roadwolf" -Project "Game Development"

# link a folder read-only: pick it in a dialog, or give the path
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Add "D:\Projects\specs"
# once: "Link to BitBull (read-only)" on Explorer's right-click menu for folders (-UninstallMenu removes it)
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -InstallMenu
# a folder with secrets: a read-only copy without them (BitBull's own repo always links this way)
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Add "C:\code\BitBull" -Hide
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Refresh bitbull
# list links (also re-mounts missing ones), remove one
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -List
powershell -ExecutionPolicy Bypass -File scripts\bitbull-wsl\link.ps1 -Remove specs
```

**Linking with the mouse.** The page can't see your disks and never sends a path. It asks the
**link helper** (`scripts/bitbull-wsl/link-helper.ps1`, kept running by the BitBull app, or started hidden by `start.ps1` when you don't use the app; listening on
`http://localhost:8790` only), which opens a Windows folder picker on the PC. Nothing is linked
unless you pick a folder there; if the folder holds keys, `.env` files or wallets, a Windows box
asks how to link it (below). The helper then runs `link.ps1`, so every check below applies. It only
answers BitBull's own page (Origin `http://localhost:8787`/`8788`), and the agent can't reach it at all
(its proxy refuses local addresses). Linking therefore works from the PC BitBull runs on, not from a
phone or another computer.

**Folders that hold secrets** (BitBull's own repo, any project with a `.env`) are linked as a
**filtered copy**: a read-only copy that leaves out `.env` (templates like `.env.example` stay),
keys, wallets, browser login stores, `node_modules`/caches and, for BitBull's repo, `data\` too. The
agent never sees those files, because they aren't there. Hiding files inside a live Windows
mount isn't reliable (Windows names are case-insensitive and have 8.3 short aliases, so a hidden
`.env` could still be opened as `.ENV` or `ENV~1`), which is why it's a copy: the folder is
mounted read-only somewhere only root in the distro can see, copied without the hidden paths,
and unmounted again. The copy changes only when you press **Refresh** (Settings → Folders, or
`link.ps1 -Refresh <name>`), which re-scans the folder for secrets first. Git history in a
linked repo is included, so a secret that was ever committed is still in `.git`.

How a link is held shut, layer by layer:

1. The `bitbull` distro sees no Windows drives (automount off). `link.ps1` mounts just that folder at
   `/srv/bitbull-links/<name>` with `ro,noexec,nosuid,nodev`, checks that a write fails, and only
   then records it. Only root in the distro can mount, and only you reach root there (from
   Windows). Links come back at boot from `/etc/bitbull-links`.
2. `bitbull-agent` gets `/srv/bitbull-links` at `/links` read-only. Its users are remapped to nobodies in
   the distro, it has no capabilities and can't mount or remount anything.
3. BitBull reads each link's mount flags from `/proc/self/mountinfo` and never hands a chat a link
   that isn't read-only.
4. Symlinks and junctions inside a linked folder resolve inside the container, so they can't
   lead anywhere else on Windows.
5. Adding or removing a link restarts every BitBull container that mounts them (about 10 s), so a
   removed link is really gone.

Both scripts refuse whole drives, network paths, Windows/program/app-data folders, your profile
root and BitBull's own repo (its `.env` holds BitBull's keys), and stop if the folder holds anything that
looks like keys, passwords or wallets (`.env`, `.ssh`, `*.pem`, `id_*`, `*.kdbx`, wallet and
seed files, browser login stores…; `-AllowSecrets` overrides). The check runs once, so don't
save secrets into a linked folder later. `copy-in.ps1` unpacks as the container's unprivileged
user, never as root, and only accepts plain path characters.

What a link can't protect against: anything the agent reads may be sent to the model it uses,
and to sites on the allowlist or that you approve. Escaping the container would need a flaw in
Docker, WSL or the kernel, so keep Windows and WSL updated. To confirm the container can't talk
to Windows' file server directly (Docker's default seccomp profile blocks `AF_VSOCK`):

```powershell
wsl -d bitbull --exec docker exec bitbull-agent python3 -c "import socket; socket.socket(40, socket.SOCK_STREAM)"
# expected: PermissionError / Operation not permitted
```


### Changing files in a linked folder

A linked folder is your real folder, so the agent never writes to it: the mount is read-only and
stays that way. What it can do, when you ask it to change files there, is **propose** the change.
BitBull shows you a card with the files and a diff for each, and nothing happens until you choose:

- **Put it on a branch** (offered first when the files are in a git repo): the helper on your PC
  makes a new branch `bitbull/<name>` from the repo's current commit, holding the change. Your
  working files, your uncommitted edits and your checked-out branch are not touched. Review it
  with `git diff HEAD...bitbull/<name>` and merge it yourself. This is the safer choice and needs
  no standing permission: a box on the PC asks each time.
- **Apply to the folder**: the helper copies the files in. This needs **Allow changes** for that
  folder first (Settings → Folders; a box on the PC asks you to confirm). What gets replaced is
  backed up first under `%LOCALAPPDATA%\BitBull\folder-backups`.
- **Decline**: nothing changes, and the agent is told.

What keeps this safe:

- **You approve every change, on screen.** Allowing changes in a folder only makes the Apply
  button available; it never lets the agent write by itself.
- **What is applied is what you were shown.** Each file's hash goes to the helper with your
  approval; a file that changed since is refused and nothing is written.
- **Some files are never written, whoever approves**, because they run on your PC without you
  choosing to run them, or hold secrets: `.git` (hooks, config), `.gitconfig`, `.githooks`,
  `.husky`, `.vscode`, `.idea`, `.devcontainer`, `.github/workflows`, shell start-up files,
  `.envrc`, `.env` and `.env.*` (templates like `.env.example` are fine), and programs and
  shortcuts (`.exe`, `.dll`, `.lnk` and the like). Nothing is written through a junction or
  symbolic link either, so a change can't leave the folder.
- **Deleting is a separate permission** (Allow deleting, per folder). Deleted files go to the
  Recycle Bin, with a copy in the backup folder.
- **Read-only when nobody is watching.** Scheduled runs and Telegram messages can't propose
  changes, and nothing could approve them if they did.
- **Listed and removable.** Settings → Folders shows every folder with changes allowed, since
  when, **Make read-only** and **Stop deleting** to take it away (no question asked), and what
  was proposed lately and what became of it. Removing a link removes its permissions.

Link the folder that holds your repos (`D:\github`, say) and the agent can read all of them
side by side, so related projects are aware of each other; each change still lands only where
you approve it. Changes work on Windows for now; on a Mac, links are read-only copies.

The rules live in `scripts/bitbull-wsl/folder-apply.ps1` (tests beside it) and
`server/src/folderChanges.ts`; a test keeps the two lists of protected paths the same.

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

Every project becomes a BitBull project (description, instructions, its docs under
`uploads/claude-import/docs/`, and Claude's memory of the project under
`uploads/claude-import/memory/`); the account-level memory files and your artifacts go to the
general workspace's `uploads/claude-import/`; every conversation becomes a chat with its original
dates and messages. The export doesn't record which project a chat belonged to, so chats arrive
unfiled unless `--project "<name>"` files them all under one; `--since 2026-01-01` skips older
ones; `--projects-only` / `--conversations-only`; `--no-artifacts`. Attachments keep their
extracted text; images are named only. Imported chats have no engine session yet, so the first
message you send in one hands the whole history to the agent as context.

**One project, with Claude's memory files**: ask Claude, in that project, to "export this
project for BitBull". It writes a folder with `project.json`, `docs/` and `memory/` (Claude's
memory files for the project, verbatim), and on the PC:

```powershell
node tools\import-project.mjs claude-export\game-development      # token read from .env
```

It creates the BitBull project (or reuses one with that name), uploads everything to
`uploads/claude-import/` with an `INDEX.md`, and prints the chat message that asks the agent
to seed Ditto from the memory files. Exports hold personal notes: keep them out of git
(`claude-export/` is ignored).

## Ditto: identity, threads, review

**Identity.** Give BitBull its own Ditto agent account instead of your personal key: once, on
your PC, `npx -y --package @heyditto/cli heyditto init --name BitBull --json`, open the
`claimURL` it prints and claim the account as yourself, then put the key it stored
(`~/.config/heyditto/cli/config.json`, or `%APPDATA%\heyditto\cli` on Windows) into `.env` as
`DITTO_API_KEY` (or into the vault via Settings). From then on everything BitBull saves shows in
your graph as the **BitBull** agent thread, labelled as such, and the key in BitBull's config is
BitBull's: revoke it without touching your own. The name is fixed at `init`, so pick it then.

**Threads.** Each BitBull chat is archived into its own Ditto session thread, titled like the chat
(`<project> · <chat title>`), via the `X-Ditto-Session-Id` / `-Name` headers, instead of Ditto's
time-based grouping. The agent's own `save_memory` calls still go through the engine's MCP
connection and are grouped by Ditto; the archive is the per-chat record.

**Main Agent.** The agent is told to ask your Ditto Main Agent (`send_message_to_agent`) for
questions that need judgement across your whole memory rather than one fact.

**Ditto Review.** The `ditto_review` tool on BitBull's own MCP runs Ditto's CLI *on the server*
(with the Ditto key, which the agent's shell never sees) against a clone in the workspace:
working, staged or since-base changes, quick/standard/deep profile, findings back as JSON.
The repo's GitHub origin has to be enabled for Ditto Review in your Ditto workspace and the key
needs review access; until then the tool returns the service's refusal. `verify-changes` and
`git-workflow` ask for it before a commit or PR. The CLI is in the image (`@heyditto/cli`).

**Provider keys.** Settings → Integrations → Ditto → Provider keys saves a GM, Engy, Instant,
OpenRouter, OpenAI, Anthropic or Google key to your Ditto account through the same CLI
(`heyditto keys set`); BitBull keeps none of them, and your Ditto endpoints bill to them before
Ditto credits. See docs/ROUTER.md.

## Keys: `.env` and the vault

`.env` is what the stack boots on; it never leaves the PC and is copied into the distro by
`deploy.ps1`. Keys you add later in **Settings → Config** go into the **vault**:
`vault.json` in BitBull's data folder, AES-256-GCM, encrypted with a key BitBull never stores.
The key is made once by the link helper on this PC and kept under `%LOCALAPPDATA%\BitBull\vault.key`,
protected with Windows DPAPI for your Windows user. When you open BitBull on this PC and click
**Unlock**, a Windows box from the link helper asks for your OK (any program on the PC can fake
a browser header, so handing the key out needs you present) and the page unlocks the vault on
the server (memory only); from a phone or another machine the vault stays locked and `.env`
applies. Why: `settings.local.json` is readable by the agent's shell (it shares the server's
user), so keys saved there were one prompt injection away from leaking; the vault file is
ciphertext to it. The first unlock moves any secrets still in `settings.local.json` into the
vault. Settings → Config shows the vault's state and a **Lock** / **Unlock from this PC**
button; rows show `vault` as their source. The vault is **at-rest** protection: while unlocked,
values live in server memory and engines are spawned without them in their environment — but
server and agent share a uid, so `/proc` is not a hard wall (see docs/THREAT-MODEL.md R1).

## Showing BitBull a window or a web page

- **Show BitBull a window** (the screen button by the paperclip): pick a window in your browser's
  share dialog and a picture of it is attached to your message. While you keep sharing, every
  message you send carries a fresh picture of it; the "Showing: …" chip stops it. Any model that
  reads images can then review what you see.
- **The BitBull browser extension** (`browser-extension/`, load it unpacked in Chrome or Edge):
  click it (or Alt+Shift+B) on any page and it sends a screenshot plus the page's text, outline,
  links, failed requests, images without alt text and unlabelled fields to your local BitBull,
  which attaches them to the chat you have open. It reads only the tab you're on, only when you
  click, and sends only to BitBull on this computer. See
  [browser-extension/README.md](browser-extension/README.md).

The model picker filters by maker (tick any number) and sorts by name, price or speed. With Ditto connected, **All / SayGM / Ditto Router** above the list (and in the Models view) shows the models from one or the other. The ⚡
figure is the typical time to the first word of a reply, measured from your own recent replies
on that model.

## Getting files out (no command line)

Whatever the agent writes, a brief, an image, a script, a whole folder, can be taken out without a shell:

- **Under each reply**, *N files from this reply* lists what that reply created or changed in the
  workspace, including files made by scripts it ran. Each file has **Download** and **Show in
  Explorer** (Finder on a Mac: the folder opens with the file selected); **Download all** saves
  them as one .zip and **Open in Explorer** opens the folder they're in.
- **Files** (the folder button on a project, or the workspace) has the same per file, plus
  **Download folder (.zip)** for whatever folder you are in.

Downloads go wherever your browser (or the desktop app) saves files, normally Downloads. They are
always saved, never opened inside BitBull, so nothing an agent writes can run in the page. Showing
in Explorer needs the link helper (the BitBull app keeps it running; without the app, `start.ps1`) and works on the
computer BitBull runs on. Endpoints: `GET /api/sessions/:id/outputs`, `GET /api/projects/:id/download?path=…`
(repeat `path` for several; folders and several files come as a .zip, up to 5,000 files / 512 MB).

## Opening folders in Explorer

The Files view shows each folder's path inside the container and inside the `bitbull` distro;
**Open in Explorer** opens it on Windows (`\\wsl.localhost\bitbull\…`) through the link helper,
which only opens folders under `bitbull-data`. `start.ps1` makes the data folder traversable for
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

## Which model for this?

On the home screen: describe a job and BitBull suggests three models from SayGM's live catalogue,
best value, best quality and the cheapest that will still do it, each with pros and cons, an
estimated cost for the whole task, and how that model has done for you here. **Use this model**
sets it for the chat. Code first keeps only models that can do the job (tools; vision when the
task involves images); the advisor model then chooses from that table with today's prices and
your record, so it never relies on what it remembers about models. The advisor is
`ADVISOR_MODEL` (default: the small model; a cheap one is enough) and **Ask a stronger model** uses
`ADVISOR_STRONG_MODEL` (default: the default model), both in Settings → Configuration.

Your record per model (turns, errors, stopped, cost, tokens, speed, last used) comes from the
turns and replies BitBull already stores: `GET /api/models/usage`, and the "Your use" column and
panel in the model browser.

## Voice

Talk to BitBull and have it talk back: the **mic button** in the message bar (click, talk, click),
**push-to-talk** (hold Ctrl+Shift+Space, or ⌘+Shift+Space on a Mac; from any app in the desktop app),
**hands-free** (the headset button: talk, pause, hear the answer, talk over it to interrupt) and
**read aloud** under any reply. Speech is written down by a Gemini model on SayGM and answered by
the chat's own model; BitBull's own gruff cartoon-dog voice (with his own laugh), plus one UK and seven US voices, is generated in the container by Piper.
Microphone, speaker, voice, speed and pause length are in Settings → Voice and kept per computer.
Details, licences and privacy: [docs/VOICE.md](docs/VOICE.md).


**QA Hound** — unleash multiple LLMs on your designated repo, folder or file to review, challenge
each other and summarise a verdict and recommendations.

The **QA Hound** button (top bar, in any chat) points up to two *other* models at a repo, folder or
file in the workspace. Each reviews it on its own in the sandbox, read-only, across the areas you tick
(attack vectors, correctness, code quality, performance, user experience) and writes a report with
evidence; then each reads the other's report and has to agree, refute or admit it can't tell,
with evidence; then the chat's own model, the primary handler, weighs both rounds, checks any
disputed point itself, and replies in the chat with a per-reviewer summary, a ranked table of
verified issues and an overall recommendation (use as is / fix first / don't use). The
reviewers' chats are in the sidebar as "QA Hound · …" and in the activity log, so their working
is inspectable and exportable. Different model families catch different things; two reviewers
from one family mostly share blind spots. `POST /api/swarm` starts one from outside (the code and
API keep the name *swarm*).

**Limits and filters** (QA Hound dialog): a hard **budget** for the whole run and a **time limit**
(the reviewers stop at 75% of the budget and 80% of the time, the rest is kept for the verdict, which
stops at the limit; a run that hits a cap ends with what it has, marked partial), a **minimum
severity** and a **minimum confidence**: the verdict scores every finding 0–100 for how sure it is,
after checking, that it is real, and anything under the thresholds is listed as held back with the
reason. **Only these paths / Never these** scope the review with globs. **Post the verdict on the
pull request** puts it on the open PR of the target repo's current branch: request changes when a
shown finding is at or above the blocking severity, approve when none is, comment when the run was
partial (and comment, saying so, on your own PR, which GitHub won't let you approve).

## Repositories

**Repos** (top bar), the branch icon on a project, or right-click a project → **Repositories**
lists every git clone in that workspace: current branch, what's uncommitted, ahead/behind its
upstream, last commit, remote, branches (local, and remote on request), stashes, and a summary
of the uncommitted changes. **Browse files** opens the Files view at that clone. The view only
reads; every other button (explain changes, fetch and compare, pull, review and propose a
commit, new branch, switch, compare) puts a request in the chat for the agent, so git actions
run in the sandbox where you can see them and the reviewer can check them.

## Ditto Router and Ditto Review

Ditto Router is a second model gateway **next to SayGM, not instead of it**. Settings →
Integrations → Ditto → **Connect Ditto**: one sign-in creates two Ditto Router endpoints (chats
with memory and your connected apps; a review one with neither, for plan mode and QA Hound) and
saves their keys. The endpoint's models join every model picker next to SayGM's, tagged *Ditto
Router*, and run natively on both engines. Your default model and where background work runs stay
as you set them: choose a Ditto Router model per chat, or make one the default in Configuration.
Its tools are attached as MCP servers inside BitBull's fences (**Ditto tools for the agent**, on
after Connect, off for a key pasted by hand), and **Manage connections** opens Ditto's Connections. Ask Ditto Review to review any branch's pull
request from Repositories. See [docs/ROUTER.md](docs/ROUTER.md).

## 404: 3D as code

404 (Bittensor subnet 17) makes every 3D object a Three.js module. There is no 404 key or MCP: the
agent clones the public [404 game recipe](https://github.com/404-Repo/404-game-recipe), follows it
(the `404-game-recipe` skill), checks each object with the recipe's verifier and a game with its jam
gate (the image ships Chromium for that), and a jam entry goes in as a pull request from your GitHub
account, after asking you. Optional: 404's open model on your own RunPod GPU
(`FOUR04_MODEL_URL`, `FOUR04_MODEL_KEY` in Settings → Integrations → 404).

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
refuses it there. That is fine on localhost and is due to move to a header or cookie before BitBull is
put behind a tunnel (docs/CLIENTS.md 0.3). `/internal/egress/check` answers only the egress
container, and `/mcp/bitbull` only the engines (a token minted at startup).

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/chat` | `{message, model?, engine?, sessionId?, projectId?, attachments?, plan?}` → `{sessionId, turnId, text, tools, errors, usage}` |
| `GET` | `/api/health` | `{ok: true}` (public) |
| `GET` | `/api/config` | Engines, default engine and model, Ditto on/off |
| `GET` | `/api/status` | Live SayGM / Ditto / sandbox checks (no model tokens spent) |
| `GET` | `/api/debug` | Tries each SayGM API shape and logs which fail |
| `GET` | `/api/models` | Live SayGM model list (`?refresh=1`) |
| `POST` | `/api/models/refresh` | Re-read the model list and reload OpenCode |
| `GET` | `/api/models/:id` | One model's details from the live catalogue |
| `GET` | `/api/models/usage` | Your record per model: turns, errors, stopped, cost, tokens, speed |
| `POST` | `/api/models/advise` | "Which model for this?": `{task, strong?}` → three picks from the live catalogue with estimated cost |
| `GET` | `/api/router/models` | Ditto Router's models, and whether background work runs on it |
| `POST` / `GET` | `/api/ditto/connect` | Connect Ditto: start the sign-in / its state |
| `GET` / `POST` | `/api/schedules` | Schedules: list / create (`{ name, prompt, projectId, model, spec, telegram }`) |
| `PATCH` / `DELETE` | `/api/schedules/:id` | Change (or pause with `enabled: false`) / delete a schedule; its chat is kept |
| `POST` | `/api/schedules/:id/run` | Run a schedule now |
| `GET` | `/api/leadpoet` | Leadpoet: connected or not, access, whether sending is allowed (never a token) |
| `POST` | `/api/leadpoet/connect`, `/finish`, `/disconnect` | Start a Leadpoet sign-in (`{ origin, access, send }`) / finish it from a pasted callback address / forget it |
| `GET` | `/api/telegram` | Telegram: the connected bot, who is paired, a live pairing code (never the token) |
| `POST` / `DELETE` | `/api/telegram/pair` | Make a one-time pairing code / cancel it |
| `POST` | `/api/telegram/unpair`, `/api/telegram/test` | Forget the paired account / send it a test message |
| `GET` | `/api/usage?days=30&offset=60` | Estimated spend per day and per model (`offset`: minutes east of UTC) |
| `GET` | `/api/compat` | Compatibility notices: SayGM or Ditto changes, lapsed keys, a newer BitBull (`?refresh=1` checks now) |
| `GET` / `POST` | `/api/ditto/keys` | Provider keys in Ditto: list (metadata only) / save one via the Ditto CLI |
| `PATCH` / `DELETE` | `/api/ditto/keys/:id` | Turn a provider key on or off / remove it |
| `GET` | `/api/voice` | Voice: Piper text-to-speech and its voices, and the speech-to-text model |
| `POST` | `/api/voice/speak` | Text to speech in the container (`{text, voice?, speed?}` → WAV); nothing leaves the machine |
| `POST` | `/api/voice/transcribe` | Speech to text: a WAV recording in, its words out (a Gemini model on SayGM) |
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
| `GET` | `/api/sessions/:id/outputs` | Files a chat's replies created or changed in its workspace |
| `GET` | `/api/projects/:id/download` | `?path=` (repeat for several): one file as itself; a folder or several paths as one .zip (up to 5,000 files / 512 MB) |
| `GET/POST` | `/api/projects/:id/files` | List a workspace folder (`?dir=`) / upload files (`file`, `path`, `target`); `general` = unfiled workspace |
| `POST` | `/api/import/conversations` | Write chats into history (`{source, projectId?, conversations:[{id,title,createdAt,messages:[{role,content,createdAt}]}]}`); ids are `<source>-<id>`, so repeats are skipped |
| `POST/GET` | `/api/swarm`, `/api/swarm/:id` | Start a QA Hound run (`{sessionId, target, models[1..2], focus?}`) / its progress; reviewer chats are ordinary sessions |
| `POST` | `/api/projects/:id/ditto-sync` | Start a Ditto seed/refresh run for the project in its own chat; `PATCH /api/projects/:id {dittoSync}` turns the standing sync on/off |
| `GET/POST` | `/api/vault`, `/api/vault/unlock {key}`, `/api/vault/lock` | Vault state; unlock with the 64-hex key (migrates secrets out of settings.local.json); lock |
| `GET` | `/api/projects/:id/repos` | Git clones in the workspace: branch, status, ahead/behind, branches, last commit (read-only) |
| `POST` | `/api/projects/:id/repos/sync` | Fetch and fast-forward one clone onto its origin (`{repo}`): the Sync button |
| `POST` | `/api/projects/:id/repos/ditto-review` | Ask Ditto Review to review a branch's open pull request (comments "@ditto review" on it) |
| `GET` | `/api/projects/:id/repos/diff` | `?repo=<path>` uncommitted-changes stat; `&base=<ref>` compares base...HEAD |
| `GET` | `/api/projects/:id/stored` | What has been mirrored to Hippius for a project |
| `POST` | `/api/stored/:id/restore` | Pull a stored file back into its workspace and verify it |
| `POST` | `/api/stored/:id/retry` | Queue a failed upload again |
| `POST` | `/api/storage/key` | Generate a Hippius encryption key (shown once) |
| `GET` | `/api/integrations`, `/api/integrations/status` | Atlas / 404 / GitHub: configuration, and live checks |
| `GET` | `/api/ditto/tools` | The tools Ditto's MCP server offers |
| `GET/POST` | `/api/skills`, `/api/skills/sync` | List / re-sync + back up skills to Ditto |
| `GET` | `/api/brand` | Name, logos and colour overrides (public) |
| `GET` | `/api/brand/asset/:file` | An image from the `brand/` folder (public) |
| `PUT` | `/api/appearance` | Save the background and sidebar colours (Settings → Appearance) into `brand.json` |
| `POST` | `/api/captures` | A page sent by the BitBull browser extension (screenshot, text, outline…; up to 16 MB) |
| `GET` | `/api/captures/next` | The next captured page waiting for the open chat |
| `GET` | `/api/links` | Read-only linked folders (name, path, entries, readOnly, noExec); listed only, never changed |
| `GET` | `/api/network` | Static allowlist, your approvals, pending/recent agent requests, recently blocked hosts |
| `POST` | `/api/network/requests/:id` | Answer an agent's request: `{decision: "host" \| "domain" \| "deny"}` |
| `POST/DELETE` | `/api/network/approved` | Allow `{host, scope: "host" \| "domain"}` / remove `/:host?scope=` |
| `GET` | `/api/activity` | Activity events (`?after=&level=&sessionId=&limit=`) |
| `GET` | `/api/activity/stream` | Live activity (SSE; `?token=` for EventSource) |

```bash
curl -s https://bitbull.example.com/api/v1/chat \
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
scripts/bitbull-wsl/        Windows: locked-down WSL distro setup, deploy, start
web/src/               React UI
```

## Adding an engine

Implement `AgentEngine` from `server/src/engines/types.ts` (yield `text` / `tool_*` /
`done` events) and register it in `server/src/agent.ts`. The UI picks it up from
`/api/config`.

## Installing the Windows app: the warning you will see

The desktop installer is **not code-signed yet**. Windows will say "Windows protected your
PC" (SmartScreen): choose **More info → Run anyway**. On a machine with **Smart App Control**
switched on — the default on a clean Windows 11 install — the installer is blocked outright
with no override. Do not turn Smart App Control off: it cannot be switched back on without
reinstalling Windows, and you do not need the installer.

BitBull itself is the Docker stack, and the desktop app is only a launcher for it. Everything
works without the installer:

```bash
cp .env.example .env   # fill it in
docker compose up -d   # then open http://localhost:8787
```

Every release publishes SHA256 checksums beside the binaries; check your download against the
one for its release before running it. Signing is planned (see `docs/CLIENTS.md`, Phase 5.5);
until then an unsigned installer is the honest state of things rather than something to work
around.

## Licence

BitBull is free software under the **GNU Affero General Public License v3.0** — see
[LICENSE](LICENSE). Copyright © 2026 BitBob Ltd.

The AGPL is chosen deliberately: BitBull is server software, and the AGPL is the licence that
asks anyone who runs a modified version as a service to publish their modifications, not only
those who distribute a copy. If you run BitBull privately, change it and never offer it to
anyone else, the AGPL asks nothing of you.
