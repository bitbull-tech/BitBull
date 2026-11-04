# BitBob desktop (Windows)

A small Tauri 2 app that wraps the sandboxed stack so BitBob is a program you install and open,
not a browser tab plus PowerShell. It does four things:

1. **Checks the machine**: WSL 2, the `bitbob` distro, Docker inside it, the containers, and
   whether BitBob answers on `127.0.0.1:8787`, with the next step spelled out when something is
   missing.
2. **Runs the repo's own scripts** with a click (`scripts/bitbob-wsl/*.ps1`: setup, start, stop,
   deploy, backup, start-at-login) and shows their output. Nothing is reimplemented in Rust:
   the scripts stay the one place that knows how to drive WSL and Docker.
3. **Opens BitBob's web UI in its own window** once the stack is up, signed in with `APP_TOKEN`
   from the repo's `.env` (optional; otherwise paste it once as in a browser).
4. **Lives in the tray.** Closing a window hides it; the stack keeps running. Quit is in the
   tray menu and also leaves the stack running (Stop is explicit).

The UI is the same `web/` bundle BitBob serves, loaded from the local server, so there is one UI
codebase. The desktop app never holds model keys and never talks to SayGM, Ditto or Hippius.

## Security shape

- Two windows. `main` (the launcher) is local HTML and may call the app's commands. `bitbob`
  shows `http://localhost:8787` and has **no IPC capability** (`src-tauri/capabilities/default.json`
  lists only `main`), so nothing BitBob serves, including anything an agent writes into a page, can
  reach the commands that run PowerShell.
- Commands run fixed argv arrays (`src-tauri/src/stack.rs`, `command_for`): the only values
  from outside are the repo path (must contain `scripts\bitbob-wsl\start.ps1` and
  `docker-compose.yml`) and the distro names (plain characters only). No shell strings.
- The token is read from `<repo>\.env` on demand, put into the BitBob origin's `localStorage` (where
  the web UI keeps it anyway) and not stored by the app. Turn "sign in with APP_TOKEN" off in
  the launcher if you'd rather paste it.
- Settings live in `%APPDATA%\io.bitbob.desktop\bitbob-desktop.json`: repo path, distro, port,
  the two toggles. No secrets.

## Build on the PC

Once, as prerequisites:

```powershell
winget install Rustlang.Rustup            # then: rustup default stable-msvc
winget install Microsoft.VisualStudio.2022.BuildTools   # tick "Desktop development with C++"
# Node 20+ is already there for BitBob itself. WebView2 is part of Windows 11.
```

Then from the repo:

```powershell
cd D:\github\BitBob\desktop
npm install
npm run tauri build
```

The installer lands in `desktop\src-tauri\target\release\bundle\nsis\BitBob_0.1.0_x64-setup.exe`
(and an `.msi` next to it). For a quick run without packaging: `npm run tauri dev`.

The first build compiles Tauri and takes a few minutes; later builds are quick.

## First run

Open **BitBob**. The launcher guesses the repo (next to the exe, then `D:\github\BitBob`);
use **Choose folder…** if it guessed wrong. Then follow the "next step" line under the checks:
it walks you through `.env`, WSL, setup, deploy and start in order. When BitBob answers, the BitBob
window opens (or press **Open BitBob**).

## Not yet

- Connection profiles for a remote BitBob (CLIENTS.md Phase 2 table): the launcher only knows the
  local stack. The BitBob window is an ordinary webview, so a remote URL is a small addition once
  per-device tokens (Phase 1) exist.
- Notifications from turn events, native drag-and-drop into the upload API, keychain storage
  for remote tokens, Linux and macOS packaging (the Rust side is portable; only the
  PowerShell actions are Windows-specific).
- Rust unit tests cover `stack.rs` (env parsing, argv shapes, output decoding, compose summary);
  the window/tray glue in `lib.rs` is exercised by running the app.
