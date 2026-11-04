# Clients: desktop, Linux and iOS

Plan for installable clients on top of the sandboxed Docker stack, agreed with Tom on
14 Oct 2026. The browser stays a first-class client throughout — the desktop and mobile
apps load the **same** `web/` bundle, so there is one UI codebase, never a fork.

Decisions taken:

| Question | Decision |
|---|---|
| Desktop shell | **Tauri 2** (Rust + the existing React bundle; same codebase can build iOS later) |
| What the desktop app does | **Manages the local Docker stack and connects to remote GMs** |
| iOS | **PWA first** (no Mac, no Apple account); native revisited after real use |
| Auth | **Per-device tokens before anything leaves localhost** |

## The contract

The server API is the only contract (`README.md` → API table). Clients stay thin: no
business logic, no model routing, no engine knowledge. Everything the agent does keeps
happening inside the sandbox; clients only ever talk to `gm-gateway`, so **no sandbox wall
moves for any of this** and `egress/allowlist.txt` gains nothing.

## Phase 0 — make the server client-ready

No new apps in this phase; it is server + web work, and every client depends on it.

### 0.1 Detached, resumable turns — **done (14 Oct 2026)**

Built in `server/src/turns.ts`, with `turns` / `turn_events` tables in `agent.db` and tests
in `server/src/turns.test.ts`. `runTurn()` is pumped there instead of by the HTTP response;
routes read the log. `POST /messages` still streams by default (so the web UI needed no
change to benefit) and `?stream=0` returns `{turnId}`; `GET /api/sessions/:id/stream?from=`
attaches or re-attaches. An `end` SSE event distinguishes "the turn finished" from "the
connection dropped", and the web client re-attaches with backoff on the latter. A turn the
server restarts through is marked `interrupted` so no client waits for it forever.
Retention: `TURN_RETENTION_DAYS` (default 7).

The original plan:

Today `POST /api/sessions/:id/messages` streams `runTurn()` straight into `streamSSE`
(`server/src/index.ts`), so the async generator is pulled by the HTTP response. If the
client goes away — phone locks, laptop sleeps, app backgrounds, tunnel blips — the turn
stalls, and there is nothing to re-attach to on reconnect. This is GAPS #6 and it is the
true prerequisite for every client below.

- `runTurn` gets its own pump, independent of any HTTP response, and appends each engine
  event to a per-turn log: `turn_events(turn_id, seq, type, json, created_at)` in
  `agent.db`, with the hot tail in memory.
- `POST /api/sessions/:id/messages` returns `{turnId, seq}` immediately (keep the current
  streaming behaviour behind `?stream=1` until clients migrate).
- `GET /api/sessions/:id/stream?turnId=&from=<seq>` attaches or **re-attaches**, replaying
  from `from` and then following live. Several clients can watch one turn.
- Retention: trim event logs for completed turns after N days (the message and its tool
  calls are already persisted in `agent.db`; the event log is only for live attach/replay).

### 0.2 `packages/client-core`

Pull the transport out of `web/src/api.ts` (every call there is a relative `/api/...`, the
token comes from `localStorage`) into a shared package:

- types (already clean in `api.ts`), the SSE parser, the turn-attach loop
- injected `baseUrl` and an injected token store, so the same code serves the browser
  (same-origin + `localStorage`), the desktop app (saved profile + OS keychain) and iOS
- `web/`, the Tauri app and any later native client all import it

### 0.3 Token out of URLs

`web/src/activity.tsx` uses `EventSource` with `?token=` because `EventSource` can't set
headers. Harmless on `127.0.0.1`; not harmless over a tunnel, where it lands in proxy and
access logs. Switch `/api/activity/stream` to the same fetch-based reader the chat already
uses, and keep `?token=` support server-side only for local dev.

### 0.4 Origins and versioning

- CORS allowlist for app origins (`tauri://localhost`, `http://localhost:1420`), **off by
  default and `.env`-only**, like the other access settings — a browser session must not be
  able to widen it (`EDITABLE` in `settings.ts`).
- `GET /api/v1/version` with capability flags, so a client can detect an older server and
  say so instead of failing oddly.

## Phase 1 — per-device tokens

`server/src/index.ts` compares one shared `APP_TOKEN`. Good enough for one browser on
localhost; wrong for a phone on the internet, where one device must be revocable without
re-keying everything.

- `devices(id, name, token_hash, scopes, created_at, last_seen_at, revoked_at)`. Scopes matter
  from day one: a scanning phone gets `capture:<project>` only (upload into one inbox, nothing
  else); see docs/CAPTURE.md §3.
- Pairing: a client already holding `APP_TOKEN` (web UI or desktop app) mints a short-lived
  code — shown as a QR for the phone — which the new device exchanges once for its own
  token. Codes expire in minutes and are single-use.
- Settings → a Devices list: name, last seen, revoke.
- `APP_TOKEN` stays the bootstrap/admin key and stays `.env`-only. Auth middleware accepts
  either, and every activity event records which device acted.

## Phase 2 — desktop app (Tauri 2) — **Windows version built (4 Nov 2026)**

`desktop/` in this repo (see its README). It loads the UI from the local server rather than
bundling `web/dist`, so the UI is identical to the browser and never out of step with the
server. Done: machine checks with a "next step" line, the five scripts as buttons with live
output, GM in its own IPC-less window signed in from `.env`, tray. Not yet: remote profiles,
notifications, native drag-and-drop, keychain, Linux/macOS packaging. Original table:

| Capability | Notes |
|---|---|
| Connection profiles | "Local (managed)" or "Remote URL + token"; several saved, switchable |
| Local stack control | start / stop / status / logs / update. Windows: drives the existing `scripts/gm-wsl/*.ps1`. Linux/macOS: `docker compose` directly |
| First-run setup | Checks for WSL/Docker, offers to run `setup.ps1`, collects `.env` values |
| Tray + notifications | Turn finished, turn failed, server unreachable (needs 0.1) |
| Native drag-and-drop | Real OS file and folder drops into the existing upload API |
| Token storage | OS keychain (Credential Manager / Keychain / libsecret), not `localStorage` |
| Packaging | NSIS + MSI (Windows), `.deb` + AppImage (Linux), `.dmg` (macOS) |

The Rust side only supervises processes and the OS integration; it never holds model keys
and never talks to SayGM.

## Phase 3 — Linux install

- `scripts/linux/install.sh`: prerequisites, clone/copy, `.env` prompt, `docker compose up
  -d --build`, same hardening as today; rootless Docker or Podman option (the compose file
  already drops all capabilities and runs read-only).
- A systemd **user** unit (`Restart=always`) replacing the WSL keep-alive trick; `loginctl
  enable-linger` so it survives logout.
- `scripts/linux/update.sh` mirroring `deploy.ps1`'s semantics: rebuild, `squid -k
  reconfigure` (never a proxy restart mid-flight), and never touch the data directory.
- Data stays outside the repo (`~/gm-data` by default, `GM_DATA_DIR` to move it).

## Phase 4 — iOS

### A. PWA (days, no Mac)

- Manifest, service worker (app shell only — never cache API responses), installable to the
  home screen, safe-area layout, mobile composer, photo/file picker into the existing
  upload API.
- Web Push works on iOS 16.4+ **only** once installed to the home screen; wire it to the
  turn-finished and error events from 0.1.
- Needs HTTPS: a **Cloudflare Tunnel** (named tunnel — no inbound port opened, the gateway
  stays bound to `127.0.0.1`), optionally with Cloudflare Access in front. Device token
  from Phase 1, paired by QR from the desktop app.

### B. Native (weeks, only if the PWA proves the use)

Tauri 2 iOS reuses the whole web codebase and `client-core`; SwiftUI would be a rewrite of
the UI for the same features. Adds share-sheet ingest ("send this photo to GM"), background
and resumable uploads for large media, and real APNs.

**Requires a Mac** (or macOS CI) with Xcode plus an Apple Developer account (~$99/yr) for
TestFlight or the App Store. Signing the macOS desktop build needs the same; Windows code
signing is a separate certificate. None of this is needed for 0–4A.

## Theming and white-labelling (done, 14 Oct 2026)

Not in the original plan, but it belongs to the client work: every colour in the UI is a
CSS token, light and dark are both first-class, and `<DATA_DIR>/brand.json` overrides the
name, logos and any token at runtime — no rebuild. The desktop and iOS clients inherit this
for free because they load the same bundle. See [BRANDING.md](BRANDING.md).

## Order of work

1. ~~**0.1 detached turns**~~ — done; it also fixed a real bug for the browser.
2. **0.2–0.4 client-core, token out of URLs, CORS, version** — small, mechanical.
3. **Phase 1 device tokens** — before any client leaves localhost.
4. **Phase 2 desktop app** — the thick client Tom wants, local-first.
5. **Phase 3 Linux install** — mostly scripts; reuses Phase 2 packaging.
6. **Phase 4A PWA + tunnel** — iOS without a Mac.
7. Reassess 4B.

## Risks

- **Detached turns touch the hottest code path** (`agent.ts`, both engines). Do it alone,
  with tests, and keep the streaming route working until clients have moved.
- **Tauri's webview differs per OS** (WKWebView on macOS, WebKitGTK on Linux). The UI is
  standard React, so the risk is low, but the Linux webview needs a real test pass.
- **A tunnel makes GM reachable from the internet.** Phase 1 is not optional; add Cloudflare
  Access if the phone is used outside the house.
- **Supervising WSL from Tauri** inherits the PowerShell quoting traps already recorded in
  `docs/HANDOFF.md` — call the existing scripts rather than reimplementing them in Rust.
- **Uploads of large media** over a phone connection need resume; the current upload route
  is one-shot. Only Phase 4 needs it.
