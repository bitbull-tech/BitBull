# GM Agent (SayGMAgent)

A personal agent on top of **[SayGM](https://saygm.com)** (one key, many models, switch
any time), with **[Ditto](https://heyditto.ai)** as long-term memory, two pluggable agent
engines (**OpenCode** and the **Claude Agent SDK**) and its own web UI.

- Chat UI with streaming, tool-call view, per-message model switching
- Engine per chat: **OpenCode** (native for every model) or **Claude Agent SDK**
- Ditto MCP wired into the agent + every turn and skill archived to Ditto
- Skills in `/skills`, versioned in Git, shared by both engines
- One Docker image, one data volume; reachable by URL with a bearer token
- `POST /api/v1/chat` for scripts and other agents

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
domains in [`egress/allowlist.txt`](egress/allowlist.txt), so the agent can't reach your
home network, Windows, or any site you haven't listed. Outside the container the agent's
shell is switched off (set `ALLOW_HOST_SHELL=true` only if you accept the risk).

```
browser ─127.0.0.1:8787─▶ gateway ─▶ gm-agent ─▶ egress (allowlist) ─▶ internet
                                  └─ sandbox network: internal ─┘
```

```bash
docker compose up -d --build      # UI + API on http://localhost:8787 (this computer only)
docker compose logs -f gm-agent   # or read data/logs/server.log
docker compose logs -f egress     # every outbound request, allowed or refused
docker compose restart egress     # after editing egress/allowlist.txt
docker compose down               # stop
```

Optional limits in `.env`: `GM_CPUS` (default 4), `GM_MEMORY` (default 6g), `GM_PORT`
(default 8787), `GM_DATA_DIR` (default `./data`).

### On Windows: a dedicated, locked-down WSL distro

A normal WSL distro mounts every Windows drive and can launch Windows programs, so it is a
thin wall. `scripts/gm-wsl/` creates a separate distro, `gm`, with Windows drive mounts
and Windows interop switched off and Docker running with user-namespace remapping (a
container escape lands as an unprivileged user that can't mount drives). Code and data
live inside it; you keep editing and committing in your Windows checkout.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\setup.ps1              # once (uses Docker in your Ubuntu distro to get a clean image)
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\deploy.ps1             # ship code changes + rebuild
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\start.ps1 -InstallAtLogin  # keep GM running, start at login
powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\start.ps1 -Stop
```

Admin inside it: `wsl -d gm -u root`. Chats and files: `\\wsl.localhost\gm\home\<you>\gm-data`
(owned by the remapped container user; read them as root).

`npm run dev` still works for UI development, with the agent's shell disabled.

## Run with Docker (any server)

```bash
cp .env.example .env   # fill it in
docker compose up -d --build
```

State lives in the `gm-data` volume (`/data`). Put it behind HTTPS (Caddy, nginx or a
Cloudflare Tunnel) before exposing it: the agent can run shell commands in its
workspace.

CI (`.github/workflows/ci.yml`) typechecks, builds and publishes
`ghcr.io/tommyhgunz14/saygmagent:latest` on every push to `main`, so a server only needs:

```bash
docker run -d --env-file .env -p 8787:8787 -v gm-data:/data ghcr.io/tommyhgunz14/saygmagent:latest
```

## API

All routes need `Authorization: Bearer $APP_TOKEN`.

| Method | Path | |
|---|---|---|
| `POST` | `/api/v1/chat` | `{message, model?, engine?, sessionId?}` → `{sessionId, text, tools, errors, usage}` |
| `GET` | `/api/models` | Live SayGM model list (`?refresh=1`) |
| `GET/POST` | `/api/sessions` | List / create (`{engine, model}`) |
| `GET/PATCH/DELETE` | `/api/sessions/:id` | History / rename / delete |
| `POST` | `/api/sessions/:id/messages` | Streaming turn (SSE): `text`, `thinking`, `tool_start`, `tool_end`, `error`, `done` |
| `POST` | `/api/sessions/:id/abort` | Stop a running turn |
| `GET/POST` | `/api/skills`, `/api/skills/sync` | List / re-sync + back up skills to Ditto |

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
web/src/               React UI
```

## Adding an engine

Implement `AgentEngine` from `server/src/engines/types.ts` (yield `text` / `tool_*` /
`done` events) and register it in `server/src/agent.ts`. The UI picks it up from
`/api/config`.
