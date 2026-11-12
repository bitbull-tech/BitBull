# BitBull — architecture & engine proposal

## End goal

A coding agent and a one-stop shop for building on Bittensor: SayGM models, Ditto memory,
Taostats subnet data, Atlas media generation, 404 3D-as-code and Hippius storage, wired together
behind one UI and API.

## Goals

1. A personal agent that sits on **SayGM** (one key, 60+ models, switch any time).
2. All history, chats and skills end up in **Ditto** (heyditto.ai) as long-term memory.
3. Own UI, own code in GitHub, **portable**: runs on a laptop, a VPS or a PaaS, reachable by URL + key.
4. Room to open it up to other users later.

## Shape

```
 Browser UI (React)  ─┐                         ┌─► SayGM  /v1/chat/completions  (OpenAI-compatible)
 curl / scripts      ─┼─► BitBull server (Hono, Node)│
 other agents        ─┘   │  bearer APP_TOKEN    └─► SayGM  /v1/messages          (Anthropic-compatible)
                          │
                          ├─ AgentEngine interface
                          │    ├─ OpenCode engine     (default, any model)
                          │    └─ Claude Agent SDK    (Claude-first)
                          │
                          ├─ Ditto MCP  ◄── agent recalls / saves facts itself
                          ├─ Ditto archive ◄── server saves every turn + every skill (idempotent)
                          ├─ SQLite (sessions + messages for the UI)
                          └─ workspace/ (files the agent creates, .claude/skills)
```

Everything engine-specific is behind one interface (`server/src/engines/types.ts`):
an engine takes `{model, prompt, systemPrompt, engineSessionId}` and yields neutral
events (`text`, `thinking`, `tool_start`, `tool_end`, `done`, `error`). The API and UI
never know which engine is running, so engines can be added or swapped freely.

## Memory design (Ditto)

Two paths, on purpose:

| Path | What | Why |
|---|---|---|
| **Agent → Ditto MCP** (`https://api.heyditto.ai/mcp`) | `search_memories`, `search_subjects`, `fetch_memories`, `save_memory`, `update_memory` … | The model recalls context before answering and saves distilled facts. Works identically on every model because it's plain MCP tool calling. |
| **Server → Ditto** (`server/src/ditto.ts`) | Every completed turn and every skill is saved with a stable `vendorId` | Guarantees nothing is lost even if a cheaper model forgets to call the tool. `vendorId` makes retries idempotent. |

Local SQLite only exists so the UI can render chat history instantly; Ditto is the
canonical, cross-app memory. Set `DITTO_ARCHIVE=off` if you only want curated facts.

Skills live in Git (`/skills`) as the source of truth, are mirrored into the workspace
for both engines, and backed up into Ditto.

## Engine proposal: Claude Agent SDK vs OpenCode

You asked for an alternative to the Claude Agent SDK that gives native interoperability
with non-Anthropic models. The repo ships **both**, selectable per chat.

| | **OpenCode** (`@opencode-ai/sdk`) | **Claude Agent SDK** |
|---|---|---|
| Licence | MIT, open source | Anthropic commercial terms |
| Model support | Native for any provider via Vercel AI SDK. Here: Claude models → SayGM Anthropic endpoint, everything else → SayGM OpenAI endpoint | Anthropic Messages API only. Non-Claude models work only if SayGM translates them behind `/v1/messages` |
| Switch model mid-conversation | Native: model is a per-prompt parameter | Works via `resume` + new `model`, but the transcript format is Claude-shaped |
| Tool calling with GPT / Gemini / open models | Uses each provider's native tool format | Depends on the gateway's translation (thinking blocks, tool schemas can degrade) |
| Agent quality on Claude | Very good | Best (it *is* Claude Code's loop: subagents, hooks, compaction, tuned prompts) |
| MCP (Ditto) | Yes (remote, headers) | Yes (http, headers) |
| Skills | Reads `.claude/skills` natively | Reads `.claude/skills` (`settingSources: ["project"]`) |
| Runtime | Spawns an `opencode serve` sidecar (bundled via npm) | Spawns the bundled Claude Code CLI per query |
| API stability | Moves fast (v1 → v2 SDK) | Stable, versioned |

**Recommendation:** make **OpenCode the default engine** (it's the one that honours the
point of SayGM — every model is first-class, and it's open source so you're never
locked in). Keep the **Claude Agent SDK engine** for Claude-heavy coding/agentic tasks
where its loop is measurably better. Because both sit behind `AgentEngine`, you can
compare them on real work and drop either later without touching the UI.

Other options considered:

- **Vercel AI SDK / Mastra / LangGraph with your own loop** — maximum control and
  smallest runtime, but you rebuild file editing, shell, compaction, sessions and
  permissions yourself. Worth it only if you outgrow both engines. It would slot in as a
  third `AgentEngine`.
- **Ditto Router** (`router.heyditto.ai/v1`) — Ditto's model gateway, wired in as a second
  gateway next to SayGM (docs/ROUTER.md): Connect Ditto creates the endpoints, their models are
  `ditto-router/<id>` in the model list, both engines route them natively, and the endpoint's
  tools (memory included) are MCP servers BitBull attaches, so plan mode still gets none.

## Portability and access

- **One container** (`Dockerfile`), state in one volume (`/data`: SQLite, workspace,
  engine session stores). Runs the same on your PC, an Ubuntu box with Compose, Fly.io,
  Railway or Render.
- **Access today:** single owner bearer token (`APP_TOKEN`) on both the UI and the API.
  The UI stores it in the browser; scripts send `Authorization: Bearer …`.
- **API:** `POST /api/v1/chat` (JSON in/out) for scripts and other agents, plus the
  streaming SSE endpoint the UI uses.
- **Expose safely:** put it behind HTTPS (Caddy, nginx or a Cloudflare Tunnel). Don't
  expose port 8787 raw: the agent can run shell commands in its workspace.

### Path to multi-user (when you open it up)

For other people, **credentials (sign-in) beat a shared API key**:

1. Add a `users` table and sign-in (e.g. Better Auth with GitHub/Google OAuth). Keep
   per-user API keys for programmatic access, hashed at rest.
2. Each user brings their own SayGM key (encrypted at rest) or you bill them through yours.
3. Each user connects **their own** Ditto via Ditto's MCP OAuth instead of a shared key.
4. Per-user workspace directory (OpenCode already scopes everything by `directory`).
5. Move SQLite → Postgres and run the agent in a per-user sandbox (container/microVM),
   since agents execute code.

The `AgentEngine` + config split is already arranged so this is additive.

## Not yet verified against live services

The sandbox this was built in couldn't reach `api.saygm.com`, so the full pipeline was
tested against a local mock of SayGM (both OpenAI and Anthropic shapes). First run, check:

- `GET /api/models` returns your SayGM models (OpenAI-style `/v1/models`).
- The Anthropic endpoint is `https://api.saygm.com/v1/messages` and accepts `x-api-key`.
  If it wants `Authorization: Bearer`, set `SAYGM_ANTHROPIC_AUTH=bearer`; if the path
  differs, change `SAYGM_ANTHROPIC_BASE_URL`.
- Ditto tool names (`save_memory`, `search_memories`, …) match Ditto's current MCP server.

## Projects (Oct 2026)

- A **project** groups chats, files and instructions. Each project has its own workspace
  folder (`DATA_DIR/projects/<slug>-<id>`), instructions injected into every turn, a colour,
  and a list of enabled integrations.
- Engines run with `cwd` = the project workspace. OpenCode events are subscribed per
  directory; the Agent SDK gets `cwd` directly.
- Moving a chat between projects resets the engine session; the next turn replays the
  conversation from local history ("recap"), so nothing is lost.
- Ditto archives are tagged `project:<name>`.

## Integrations harness

`server/src/integrations.ts` is a registry: each entry declares its env vars, an optional
MCP endpoint and a live probe. Projects opt in; engines receive only the enabled MCPs
(OpenCode registers all and disables the rest per prompt with `tools: {"<id>_*": false}`).

| Env | Purpose |
|---|---|
| `ATLAS_API_KEY`, `ATLAS_MCP_URL` | Atlas MCP (alpha): projects, platform agent, exported APIs |
| `ATLAS_WORKFLOWS_DIR` | Exported workflow specs, run by `tools/atlas-run.mjs` (upload → execute_async → poll → download) |
| `FOUR04_MODEL_URL`, `FOUR04_MODEL_KEY` | Optional: 404's open model on your own RunPod GPU. 404 itself needs no key or MCP (public recipe, `404-game-recipe` skill) |
| `ENABLE_WEB_SEARCH`, `ENABLE_LSP` | OpenCode websearch (Exa) and experimental LSP tool |

## Coding parity with Claude Code

Engine-provided: read/write/edit/apply_patch/glob/grep, bash, subagents (`task`), todo list,
webfetch/websearch, AGENTS.md/CLAUDE.md, compaction. Added in this pass: plan mode
(read-only `bitbull-plan` agent / Agent SDK plan mode), todo checklist in the UI, ten skills
(`coding-workflow`, `git-workflow`, `verify-changes`, `code-review`, `debug-systematically`,
`repo-onboarding`, `project-recall`, `atlas-studio`, `taostats-api`).
Gaps: per-action approvals (the `question` tool is disabled because nothing can answer it),
diff/undo UI over OpenCode snapshots, slash commands and hooks, images passed as vision
parts, adding arbitrary MCP servers from the UI.

## Open decisions and risks

1. **No sandbox**: bypassPermissions runs shell on the host. Containerise per project before
   other users.
2. **Privacy**: full-turn Ditto archiving keeps everything said in a chat; add a
   per-project archive switch.
3. **Atlas runner** needs one real exported spec to confirm field names.
4. **Spend caps** for Atlas credits; **object storage** for media; **C2PA** labels.
