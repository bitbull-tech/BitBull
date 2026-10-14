# CLAUDE.md — GM Agent (SayGMAgent)

Read this first, then `docs/HANDOFF.md` (full history, decisions and open items), `README.md`
(what runs where, data flow) and `docs/GAPS.md` (what's missing vs other coding agents).

## What this is

Tom's own AI agent platform: a web UI + API server that runs agent engines (**OpenCode**
by default, or the **Claude Agent SDK**) on any model from the **SayGM** gateway, with
**Ditto** (heyditto.ai) as long-term memory. It runs sandboxed in Docker (on Windows inside a
locked-down WSL distro called `gm`). End goal: a platform for custom historical/hereditary
experiences (old photos, film, documents → grounded cinematic/interactive pieces) combining
SayGM models, Atlas AI Studio / 404.xyz media generation and agentic coding.

Next phase (why you're here): **desktop, Linux and iOS implementations**. Plan and decisions
in `docs/CLIENTS.md` (start at Phase 0: detached turns); background in "Next" in
docs/HANDOFF.md.

## Layout

```
server/src/          Node 22 + TypeScript, Hono, node:sqlite (no native deps)
  index.ts           HTTP API, auth (bearer APP_TOKEN), static UI
  agent.ts           turn runner: history, system prompt, engines, redaction, Ditto archive, activity
  turns.ts           turns outlive their connection: event log per turn, attach/replay by seq
  brand.ts           white-label (DATA_DIR/brand.json + brand/): validated name, logos, CSS tokens
  engines/opencode.ts  OpenCode server (spawned), per-model native API routing, subagents, gm-guard plugin
  engines/claude.ts    Claude Agent SDK engine (Anthropic-shape SayGM models only)
  config.ts          env + UI overrides (DATA_DIR/settings.local.json), live reloadConfig()
  settings.ts        Settings API (EDITABLE allowlist), status probes
  activity.ts        activity feed (memory + logs/activity.jsonl, SSE), redact()
  export.ts          chat/exchange export (full or compact) for other agents
  subagents.ts       loads subagents/*.md for both engines; READ_ONLY_BASH rules
  integrations.ts    Atlas, 404, GitHub (+ probes); ditto.ts; models.ts; skills.ts; db.ts
web/src/             React + Vite UI (App, Chat, Settings, FilesDialog, ExportMenu, activity.tsx)
  brand.ts           brand fetch + CSS-token injection;  BrandMark.tsx  logo/initials
  index.css          all colour lives in tokens at the top; the sidebar re-declares its own
agent/SYSTEM.md      base system prompt;  agent/opencode-plugin/gm-guard.js  secret guard
skills/              skills mirrored into every workspace (.claude/skills) and backed up to Ditto
subagents/           reviewer, challenger, debugger, tester, worker, fact-checker
egress/              squid allowlist proxy (allowlist.txt) + socat gateway image
scripts/gm-wsl/      Windows: setup.ps1 (create gm distro), deploy.ps1, start.ps1
docs/                ARCHITECTURE.md, HANDOFF.md, GAPS.md, CLIENTS.md (desktop/Linux/iOS), STORAGE.md
```

## Commands

```bash
npm run setup                 # install server + web deps
npm run dev                   # API :8787 + Vite UI :5173 (host mode: agent shell OFF)
npm run typecheck             # both packages
cd server && npm test         # node:test via tsx (subagents tests)
cd web && npx vite build      # UI build (server serves web/dist)
docker compose up -d --build  # sandboxed: gm-agent + gm-egress + gm-gateway on 127.0.0.1:8787
```

Windows (Tom's machine): edit/commit in `D:\github\SayGMAgent`, ship with
`powershell -ExecutionPolicy Bypass -File scripts\gm-wsl\deploy.ps1` (copies code + .env into the
`gm` distro and rebuilds). Live data lives in `~/gm-data` inside `gm`, never on D:.

## Rules that matter

- **Never print, log or commit secrets.** Check keys by length/prefix only. `.env`,
  `settings.local.json` and Atlas workflow specs stay out of git. Everything user-visible goes
  through `redact()`.
- Keep the sandbox walls: no new host mounts, no docker.sock, nothing that lets the UI change
  `APP_TOKEN`/sandbox/proxy settings (see `EDITABLE` in settings.ts). New outbound domains go in
  `egress/allowlist.txt` deliberately.
- Engine-neutral events only (`server/src/engines/types.ts`); the UI must not care which engine ran.
- SayGM models are routed by their `api_shapes`: messages→Anthropic, responses→OpenAI Responses,
  generateContent→Google, else chat.completions. GPT-5.x rejects tools+reasoning on chat.completions.
- Verify before claiming done: typecheck, build, `npm test`, and for UI a Playwright screenshot
  (Chromium is preinstalled in Claude cloud sandboxes at /opt/pw-browsers).
- Taostats: v1 API only (`/v1/…`, raw key in Authorization, no Bearer); see skills/taostats-api.
- Tom prefers concise, plain-English answers and step-by-step PowerShell when he must run things.
