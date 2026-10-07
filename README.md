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

Requires Node 22+.

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
