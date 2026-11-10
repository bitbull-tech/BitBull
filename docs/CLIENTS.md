# Clients: desktop (Windows, macOS), Linux and iOS

Plan for installable clients on top of the sandboxed Docker stack, agreed with Tom on
14 Oct 2026. The browser stays a first-class client throughout — the desktop and mobile
apps load the **same** `web/` bundle, so there is one UI codebase, never a fork.

Decisions taken:

| Question | Decision |
|---|---|
| Desktop shell | **Tauri 2** (Rust + the existing React bundle; same codebase can build iOS later) |
| What the desktop app does | **Manages the local Docker stack and connects to remote BitBulls** |
| iOS | **PWA first** (no Mac, no Apple account); native revisited after real use |
| Auth | **Per-device tokens before anything leaves localhost** |
| macOS (7 Nov 2026) | **macOS 13+, Apple Silicon and Intel; Colima VM by default, Docker Desktop / OrbStack if chosen** |

## The contract

The server API is the only contract (`README.md` → API table). Clients stay thin: no
business logic, no model routing, no engine knowledge. Everything the agent does keeps
happening inside the sandbox; clients only ever talk to `bitbull-gateway`, so **no sandbox wall
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
  else).
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
output, BitBull in its own IPC-less window signed in from `.env`, tray. Not yet: remote profiles,
notifications, native drag-and-drop, keychain, Linux/macOS packaging. Original table:

| Capability | Notes |
|---|---|
| Connection profiles | "Local (managed)" or "Remote URL + token"; several saved, switchable |
| Local stack control | start / stop / status / logs / update. Windows: drives the existing `scripts/bitbull-wsl/*.ps1`. Linux/macOS: `docker compose` directly |
| First-run setup | Checks for WSL/Docker, offers to run `setup.ps1`, collects `.env` values |
| Tray + notifications | Turn finished, turn failed, server unreachable (needs 0.1) |
| Native drag-and-drop | Real OS file and folder drops into the existing upload API |
| Token storage | OS keychain (Credential Manager / Keychain / libsecret), not `localStorage` |
| Packaging | NSIS + MSI (Windows), `.deb` + AppImage (Linux), `.dmg` (macOS) |

The Rust side only supervises processes and the OS integration; it never holds model keys
and never talks to SayGM.

The app as built assumes a checkout: its **Repository and stack** setting points at
`D:\github\BitBull` and it runs that folder's own scripts, so the app and the scripts can
never drift apart. That is right for development and wrong for everyone else — Phase 5
below keeps it as the `--dev` path and replaces the default.

## Phase 3 — Linux install

- `scripts/linux/install.sh`: prerequisites, clone/copy, `.env` prompt, `docker compose up
  -d --build`, same hardening as today; rootless Docker or Podman option (the compose file
  already drops all capabilities and runs read-only).
- A systemd **user** unit (`Restart=always`) replacing the WSL keep-alive trick; `loginctl
  enable-linger` so it survives logout.
- `scripts/linux/update.sh` mirroring `deploy.ps1`'s semantics: rebuild, `squid -k
  reconfigure` (never a proxy restart mid-flight), and never touch the data directory.
- Data stays outside the repo (`~/bitbull-data` by default, `BITBULL_DATA_DIR` to move it).

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
the UI for the same features. Adds share-sheet ingest ("send this photo to BitBull"), background
and resumable uploads for large media, and real APNs.

**Requires a Mac** (or macOS CI) with Xcode plus an Apple Developer account (~$99/yr) for
TestFlight or the App Store. Signing the macOS desktop build needs the same; Windows code
signing is a separate certificate. None of this is needed for 0–4A.

## Phase 5 — installable without the source (gates the open-source release)

Agreed with Tom on 5 Nov 2026, after the Windows desktop app was built and installed.

Everything above assumes the person running BitBull also builds it. For an open-source
release that assumption breaks: most people will use BitBull **on** their projects, not work
on BitBull itself. The symptom is visible in the launcher today — its most prominent control
is **Repository and stack**, a path to BitBull's own checkout. Two different things are
called "the repo" (BitBull's source, and the user's projects), and the only one the user
cares about is the one that isn't shown. The fix is not to redesign that control but to
delete it from the normal path.

Five pieces. 5.1 and 5.2 are blockers — without them a new user cannot install BitBull at
all. 5.3–5.5 are what make it feel like a product.

### 5.1 Published images, not a build on the user's machine — **done (5 Nov 2026)**

`docker-compose.yml` now references `ghcr.io/tommyhgunz14/bitbull` and `…/bitbull-egress`
(overridable with `BITBULL_IMAGE` / `BITBULL_EGRESS_IMAGE`, versioned with `BITBULL_TAG`), and
builds nothing. The `build:` keys moved to `docker-compose.dev.yml`, which `deploy.ps1`,
`setup.ps1` and `test-stack.ps1` select through `COMPOSE_FILE`, so the development loop is
unchanged. CI's `docker` job publishes **both** images from a matrix, tagging every push with
its commit SHA, `main` with `latest`, and a `v1.2.3` git tag with `1.2.3`; a published version
tag is never moved.

Still open, and deliberately not guessed at here:

- ~~Base images are not digest-pinned~~ — **done**: both Dockerfiles pin by digest, with the
  update procedure in a comment at the top of each. The tag stays in the `FROM` line for
  humans; the digest is what builds.
- **No provenance or SBOM attestation.** `build-push-action`'s `provenance`/`sbom` inputs need
  the buildx driver, i.e. a `docker/setup-buildx-action` step, which means another action to
  SHA-pin. Worth doing before the first tagged release.
- **A user still needs the tree**, because compose itself and `egress/allowlist.txt` are read
  from disk. 5.3 is what removes that.

The original plan:


`docker-compose.yml` is `build: .` (and `build: ./egress`), so first run is an `npm install`
plus two Docker builds inside the distro: minutes, and it requires the whole source tree to
be present and a toolchain to work.

- CI builds and pushes `ghcr.io/tommyhgunz14/bitbull:<version>` and
  `ghcr.io/tommyhgunz14/bitbull-egress:<version>` on tag.
- The compose file gets plain `image:` keys; the `build:` keys move behind a `dev` profile,
  so `docker compose --profile dev up --build` stays exactly today's inner loop.
- First run becomes `docker compose pull` — seconds, and the source tree stops being needed
  at all.

The security argument is stronger than the convenience one. Today every user runs whatever
npm resolved on their machine that morning, inside a container that an agent has a shell in.
Pinned, reproducible images built by CI — ideally with provenance attestation and an SBOM —
are a far better story for a project whose selling point is the sandbox. This is also what
makes `BITBULL_TAG` in the compose file mean something: today it defaults to `local`.

### 5.2 Bootstrap the distro from a downloaded rootfs — **written 5 Nov 2026, untested**

`setup.ps1` now downloads Canonical's published Ubuntu 24.04 WSL root filesystem from
`cloud-images.ubuntu.com/wsl/releases/24.04/current/` and verifies it against the
`SHA256SUMS` published beside it, then `wsl --import`s it. No existing distro, no Docker on
Windows, no Microsoft Store. It also checks for WSL 2 up front and prints the
`wsl --install --no-distribution` instruction rather than failing obscurely. `-Rootfs` takes
a tarball you already have, `-Sha256` pins an expected hash, and `-Source` keeps the old
export-from-Docker path as an explicit fallback.

Two things the published checksum does **not** give us: it travels with the file, so it
proves the download arrived intact rather than that it is the image anyone reviewed, and
`SHA256SUMS.gpg` is not checked (that needs Canonical's signing key on the machine). The
answer is `-Sha256`: after a good run the script prints the hash it used, and pinning it as
the default puts it in git where it is reviewed like any other change.

**Not yet exercised.** Every path goes through `wsl.exe`, so none of it can be tested from a
cloud session. The open question is whether `provision.sh` runs clean on this base: the
cloud-images rootfs is a fuller Ubuntu than the `ubuntu:24.04` Docker export it replaces
(snapd, cloud-init, the WSL first-run setup), and `/etc/wsl.conf` is overwritten by
provisioning, so `[boot] command` rather than systemd still starts Docker. Test against a
throwaway `-Distro` name with the live stack stopped, since both would bind 127.0.0.1:8787.

The original plan:


`scripts/bitbull-wsl/setup.ps1` takes `-Source Ubuntu` and exports a clean `ubuntu:24.04`
image **out of an existing distro that already has Docker**. No new user clears that: they
would need Ubuntu and Docker installed before they can install the thing that installs
Docker. It is a chicken-and-egg bootstrap that only works because Tom's machine already had
both.

- Fetch Canonical's published Ubuntu 24.04 WSL rootfs, verify it against a checksum pinned
  in the installer, and `wsl --import bitbull <dir> <tarball>`.
- The only remaining prerequisite is WSL2 itself, which the wizard installs with
  `wsl --install --no-distribution` (plus a reboot prompt, and a clear message when
  virtualization is off in firmware — that one needs the user's BIOS, not a script).
- `provision.sh` is unchanged: it already installs Docker Engine **inside** the distro via
  `get.docker.com`, with userns remapping. Keep that. Requiring Docker Desktop would be a
  licensing and install burden most competitors carry and BitBull does not.

### 5.3 A versioned runtime payload the app owns

`docker-compose.yml`, `egress/allowlist.txt`, `provision.sh` and `scripts/bitbull-wsl/*.ps1`
ship inside the installer and unpack to `%LOCALAPPDATA%\BitBull\runtime\<version>\`.

- The app then knows which runtime version it is on, instead of pointing at a folder the
  user may have edited. "Deploy after a code change" — a developer's verb — becomes
  "Update available → pull → recreate".
- It also stops a user quietly editing `allowlist.txt` in a folder they assume is theirs.
- Keep the payload platform-neutral: Phase 3's Linux install wants the same compose file and
  the same published images, minus the WSL layer entirely.

### 5.4 First-run wizard, and the folder control becomes theirs

First run, once, in this order: check Windows build and virtualization → install WSL2 →
import the distro → `compose pull` → make the vault key (existing `link-helper.ps1`
`/vault-key`) → enter a SayGM key → open BitBull.

After that the launcher's single folder control reads **Projects folder**, wired to what
`scripts/bitbull-wsl/link.ps1` already mounts read-only at `/links`. That is the folder a
user actually wants to point at, and the plumbing for it exists.

Repo, distro and port collapse into an **Advanced** section, collapsed by default. A
`--dev <path>` flag (or a `BITBULL_DEV_REPO` setting) restores today's behaviour exactly:
point at a checkout, build from source, Deploy. Tom's workflow is unchanged; a user never
sees it.

### 5.5 Code signing

Tom's own build was blocked by Smart App Control (`VerifiedAndReputableDesktop`) and he had
to turn it off to proceed. Every user will hit the same wall on an unsigned installer, and
telling people to disable a Windows security feature in order to install a security-focused
agent is not a viable launch. Azure Trusted Signing is the cheap route in; it needs sorting
**before** the repo goes public, not after. (macOS signing is the separate Apple account in
Phase 4B; neither is needed for Linux.)

### What does not change

The sandbox walls. Docker Engine inside a locked-down distro with userns remapping, the
squid allowlist proxy, the gateway bound to `127.0.0.1`, `/links` read-only — that is the
differentiator, and none of it should be traded for an easier install. Nothing in Phase 5
moves a wall; it only changes where the bytes come from and what the first screen asks for.

## Phase 6 — macOS (written 7 Nov 2026, not yet run on a Mac)

Same stack, same launcher, same web UI; only the layer that Windows gets from WSL changes.

| | Windows | Mac |
|---|---|---|
| Where the containers run | the `bitbull` WSL distro, Docker with userns-remap | a Colima VM called `bitbull` (vz + virtiofs), or Docker Desktop / OrbStack if chosen at setup |
| What that layer can see | no Windows drives, no interop | only `~/Library/Application Support/BitBull` (the one Colima mount) |
| Scripts | `scripts/bitbull-wsl/*.ps1` | `scripts/bitbull-mac/*.sh` (bash 3.2, no Homebrew bash needed) |
| Deployed code / data / links | `~/BitBull`, `~/bitbull-data`, `/srv/bitbull-links` in the distro | `app/`, `data/`, `links/` under BitBull's folder |
| Linked folders | read-only bind mounts (live) | read-only **copies** (secrets left out unless chosen); Refresh to update |
| Link helper | `link-helper.ps1`, started by `start.ps1` | built into the app (`desktop/src-tauri/src/helper.rs`), same HTTP API on `localhost:8790` |
| Vault key | DPAPI file in `%LOCALAPPDATA%\BitBull` | login Keychain item `io.bitbull.vault`, owned by the app |
| Start at login | Startup shortcut | LaunchAgent `io.bitbull.stack`, which also opens the app (for the helper) |
| Installer | NSIS / MSI from `npm run tauri build` | universal `.dmg` from the `macos` workflow |

Decisions and reasons:

- **macOS 13 minimum.** Colima's `vz` driver and virtiofs need it; Docker Desktop only supports the
  current and two previous releases; Homebrew lists 10.15–13 as Tier 3 (unsupported). Catalina
  was asked about and is out: the sandbox has no maintained runtime there, and the OS itself has
  had no security updates since 2022.
- **Copies instead of mounts.** Colima's mounts are fixed when the VM starts; mounting each linked
  folder would mean sharing far more of the Mac with the VM, or restarting it per link. A copy
  in BitBull's own folder needs neither, and the agent still can't touch the original.
- **The helper in the app.** macOS has no PowerShell, and a native app gets native dialogs and
  Keychain access control (another program asking for the vault key gets the system's prompt).
  The page's API is unchanged, so `web/` only needed wording (Finder, "this computer").
- **Images for arm64.** CI publishes `linux/amd64,linux/arm64` (QEMU on the x86 runner). The local
  deploy builds natively anyway; published images matter once installs stop building (5.1).

Still to do: the first run on a real Mac (setup with each runtime, deploy, link, vault, start at
login), whether the native dialogs come to the front over the browser on macOS 14+ (cooperative
activation), signing and notarising (5.5), and a test-stack script like `test-stack.ps1`.

## Theming and white-labelling (done, 14 Oct 2026)

Not in the original plan, but it belongs to the client work: every colour in the UI is a
CSS token, light and dark are both first-class, and `<DATA_DIR>/brand.json` overrides the
name, logos and any token at runtime — no rebuild. The desktop and iOS clients inherit this
for free because they load the same bundle. See [BRANDING.md](BRANDING.md).

## Order of work

1. ~~**0.1 detached turns**~~ — done; it also fixed a real bug for the browser.
2. **0.2–0.4 client-core, token out of URLs, CORS, version** — small, mechanical.
3. **Phase 1 device tokens** — before any client leaves localhost.
4. ~~**Phase 2 desktop app**~~ — Windows built 4 Nov 2026; remote profiles and keychain outstanding.
5. **Phase 5.1–5.2 published images + rootfs bootstrap** — these gate the open-source
   release; until they are done a new user cannot install BitBull at all.
6. **Phase 5.5 code signing** — in parallel with 5.1–5.2; it has lead time.
7. **Phase 5.3–5.4 runtime payload + first-run wizard** — makes it a product rather than a
   checkout with a launcher.
8. **Phase 3 Linux install** — mostly scripts, and much cheaper once 5.1 exists (same
   images, same compose file, no WSL layer).
9. **Phase 4A PWA + tunnel** — iOS without a Mac.
9a. **Phase 6 macOS** — written 7 Nov 2026; needs its first run on a Mac.
10. Reassess 4B.

## Risks

- **Detached turns touch the hottest code path** (`agent.ts`, both engines). Do it alone,
  with tests, and keep the streaming route working until clients have moved.
- **Tauri's webview differs per OS** (WKWebView on macOS, WebKitGTK on Linux). The UI is
  standard React, so the risk is low, but the Linux webview needs a real test pass.
- **A tunnel makes BitBull reachable from the internet.** Phase 1 is not optional; add Cloudflare
  Access if the phone is used outside the house.
- **Supervising WSL from Tauri** inherits the PowerShell quoting traps already recorded in
  `docs/HANDOFF.md` — call the existing scripts rather than reimplementing them in Rust.
- **Uploads of large media** over a phone connection need resume; the current upload route
  is one-shot. Only Phase 4 needs it.
- **Publishing images makes BitBull a supply chain** (5.1). A pushed tag runs on other
  people's machines with an agent inside it, so the registry credentials and the release
  workflow become security-critical: pinned action SHAs, least-privilege `GITHUB_TOKEN`,
  no secrets reachable from a PR build, and tags that are never moved once published.
- **The rootfs download is a trust decision** (5.2). Pin the checksum in the installer and
  fail closed on a mismatch; an unverified rootfs is root in the sandbox before it starts.
- **Two install paths will drift** (5.4). The dev path builds from a checkout and the user
  path pulls images; a bug that only appears in one will be found by users, not by Tom. CI
  should install from the published artefacts the way a user would and run the stack tests
  against that, not only against a source build.
