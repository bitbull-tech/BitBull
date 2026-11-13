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
| `GET` / `POST` | `/api/schedules` | Schedules: list / create (`{ name, prompt, projectId, model, spec }`) |
| `PATCH` / `DELETE` | `/api/schedules/:id` | Change (or pause with `enabled: false`) / delete a schedule; its chat is kept |
| `POST` | `/api/schedules/:id/run` | Run a schedule now |
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
  -d '{"message":"What did I decide about the release plan?","model":"gpt-5"}'
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

## Licence
BitBull is free software under the **GNU Affero General Public License v3.0** — see
[LICENSE](https://github.com/bitbull-tech/BitBull/blob/main/LICENSE). Copyright © 2026 BitBob Ltd.

The AGPL is chosen deliberately: BitBull is server software, and the AGPL is the licence that
asks anyone who runs a modified version as a service to publish their modifications, not only
those who distribute a copy. If you run BitBull privately, change it and never offer it to
anyone else, the AGPL asks nothing of you.
