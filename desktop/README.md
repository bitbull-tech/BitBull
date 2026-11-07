# BitBull desktop (Windows and macOS)

A small Tauri 2 app that wraps the sandboxed stack so BitBull is a program you install and open,
not a browser tab plus PowerShell. It does four things:

1. **Checks the machine**: WSL 2, the `bitbull` distro, Docker inside it, the containers, and
   whether BitBull answers on `127.0.0.1:8787`, with the next step spelled out when something is
   missing.
2. **Runs the repo's own scripts** with a click (`scripts/bitbull-wsl/*.ps1`: setup, start, stop,
   deploy, backup, start-at-login) and shows their output. Nothing is reimplemented in Rust:
   the scripts stay the one place that knows how to drive WSL and Docker.
3. **Opens BitBull's web UI in its own window** once the stack is up, signed in with `APP_TOKEN`
   from the repo's `.env` (optional; otherwise paste it once as in a browser).
4. **Lives in the tray.** Closing a window hides it; the stack keeps running. Quit is in the
   tray menu and also leaves the stack running (Stop is explicit).

The UI is the same `web/` bundle BitBull serves, loaded from the local server, so there is one UI
codebase. The desktop app never holds model keys and never talks to SayGM, Ditto or Hippius.

## Security shape

- Two windows. `main` (the launcher) is local HTML and may call the app's commands. `bitbull`
  shows `http://localhost:8787` and has **no IPC capability** (`src-tauri/capabilities/default.json`
  lists only `main`), so nothing BitBull serves, including anything an agent writes into a page, can
  reach the commands that run PowerShell.
- Commands run fixed argv arrays (`src-tauri/src/stack.rs`, `command_for`): the only values
  from outside are the repo path (must contain `scripts\bitbull-wsl\start.ps1` and
  `docker-compose.yml`) and the distro names (plain characters only). No shell strings.
- The token is read from `<repo>\.env` on demand, put into the BitBull origin's `localStorage` (where
  the web UI keeps it anyway) and not stored by the app. Turn "sign in with APP_TOKEN" off in
  the launcher if you'd rather paste it.
- Settings live in `%APPDATA%\io.bitbull.desktop\bitbull-desktop.json`: repo path, distro, port,
  the two toggles. No secrets.

## Build on the PC

Once, as prerequisites:

```powershell
winget install Rustlang.Rustup            # then: rustup default stable-msvc
winget install Microsoft.VisualStudio.2022.BuildTools   # tick "Desktop development with C++"
# Node 20+ is already there for BitBull itself. WebView2 is part of Windows 11.
```

Then from the repo:

```powershell
cd D:\github\BitBull\desktop
npm install
npm run tauri build
```

The installer lands in `desktop\src-tauri\target\release\bundle\nsis\BitBull_0.1.0_x64-setup.exe`
(and an `.msi` next to it). For a quick run without packaging: `npm run tauri dev`.

The first build compiles Tauri and takes a few minutes; later builds are quick.

## First run

Open **BitBull**. The launcher guesses the repo (next to the exe, then `D:\github\BitBull`);
use **Choose folder…** if it guessed wrong. Then follow the "next step" line under the checks:
it walks you through `.env`, WSL, setup, deploy and start in order. When BitBull answers, the BitBull
window opens (or press **Open BitBull**).

## On a Mac

The same app and launcher window, built for macOS 13+ (universal: Apple Silicon and Intel).

- **Checks** read from `scripts/bitbull-mac/status.sh`: the runtime (Colima, or the Docker Desktop /
  OrbStack you chose at setup), the `bitbull` VM, Docker, the containers. The "distro" field is the
  Colima profile (VM) name.
- **Actions** run `scripts/bitbull-mac/*.sh` through `/usr/bin/env PATH=… BITBULL_PROFILE=…
  BITBULL_PORT=… /bin/bash <script>`: argv only, with Homebrew's paths added because an app starts
  with a bare PATH. Setup offers Colima (its own VM, recommended) or the engine you already run.
- **It is the link helper** (`src-tauri/src/helper.rs`): BitBull's page talks to it on
  `localhost:8790` exactly as it talks to `link-helper.ps1` on Windows. Folder picker and every
  confirmation are native dialogs from the app; the vault key lives in the login Keychain
  (service `io.bitbull.vault`), handed out only after you press Unlock. Everything but the dialogs,
  the Keychain and the listeners is tested on any OS (`cargo test`).
- **Build**: the `macos` GitHub workflow (`.github/workflows/macos.yml`) builds the universal `.dmg`
  on GitHub's macOS runners, on a `v*` tag or by hand (Actions → macos → Run workflow). On a Mac
  yourself: `xcode-select --install`, rustup with both Apple targets, then
  `cd desktop && npm ci && npx tauri build --target universal-apple-darwin --bundles app,dmg`.
- **Unsigned for now.** Gatekeeper blocks the first open ("Apple cannot check it"): right-click
  BitBull → Open, once. Signing and notarising need an Apple Developer ID (CLIENTS.md 5.5); until
  then each new build is a new identity to the Keychain, which may ask once to let it read the
  vault key again.
- Settings live in `~/Library/Application Support/io.bitbull.desktop/bitbull-desktop.json`.

## Not yet

- Connection profiles for a remote BitBull (CLIENTS.md Phase 2 table): the launcher only knows the
  local stack. The BitBull window is an ordinary webview, so a remote URL is a small addition once
  per-device tokens (Phase 1) exist.
- Notifications from turn events, native drag-and-drop into the upload API, keychain storage
  for remote tokens, Linux packaging.
- Not yet run on a real Mac: the scripts are linted and the link copying tested on Linux, the
  Rust side unit-tested, but the first real run is the test (CLIENTS.md Phase 6).
- Rust unit tests cover `stack.rs` (env parsing, argv shapes for both platforms, output decoding,
  compose summary, the Mac checks) and `helper.rs` (request parsing, origins, consent, paths);
  the window/tray glue in `lib.rs` is exercised by running the app.
