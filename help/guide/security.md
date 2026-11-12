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
  `.env`; see [docs/STORAGE.md](https://github.com/bitbull-tech/BitBull/blob/main/docs/STORAGE.md). With `STORAGE_MIRROR=off`, nothing is sent.
  Still back up `~/bitbull-data` for the database and workspaces (for example
  `wsl -d bitbull -u root -- tar -czf - -C /home/<you> bitbull-data > bitbull-data.tgz`): Hippius holds the
  files you uploaded, not the chats.

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
