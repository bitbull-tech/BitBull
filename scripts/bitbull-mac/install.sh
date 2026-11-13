#!/bin/bash
# BitBull on a Mac in one command. Paste this into Terminal (it works the same in zsh, the Mac's
# default shell, because it runs under bash however it is started):
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/bitbull-tech/BitBull/main/scripts/bitbull-mac/install.sh)"
#
# That one paste is the whole install. It asks nothing, except your Mac password once if
# Homebrew has to be installed:
#   - Homebrew: installed if missing and put on your PATH, for this window and for new ones
#     (~/.zprofile), which Homebrew's installer leaves you to do by hand on Apple Silicon.
#   - git: Apple's Command Line Tools come with Homebrew; nothing else to install.
#   - .env: created for you, with a strong APP_TOKEN (your BitBull password). No file to edit.
#   - Then setup.sh and start.sh --install-at-login.
#   - The BitBull app: downloaded from BitBull's latest release into Applications and opened, so
#     BitBull has its own window and menu-bar icon, signed in. If the app can't be installed (no
#     release yet, no network), BitBull opens in your browser instead, also signed in.
#   - BitBull's first screen asks for the two things only you have: your SayGM key (paste it
#     there) and Ditto (a sign-in, nothing to copy).
#
# Run it again any time: it updates the code (git pull) and keeps everything already in .env.
#
#   ... --dir ~/code/BitBull     where to put BitBull (default ~/BitBull)
#   ... --runtime docker         use the Docker Desktop / OrbStack you already run (default: Colima)
#   ... --ask-keys               ask for the SayGM and Ditto keys here in Terminal (typing hidden)
#                                instead of on BitBull's first screen
#   ... --browser                don't install the app; open BitBull in the browser
#   ... --no-start               stop once .env is ready; run setup.sh yourself later
#
# Written for the bash that ships with macOS (3.2). Prompts read from the terminal (/dev/tty), so
# `curl … | bash` works too. Keys are never printed, logged or passed on a command line.

set -u

DIR="$HOME/BitBull"
RUNTIME=colima
ASK_KEYS=0
START=1
USE_APP=1
APP_DMG_URL="https://github.com/bitbull-tech/BitBull/releases/latest/download/BitBull-macos.dmg"
APP_ID="io.bitbull.desktop"
REPO_URL="https://github.com/bitbull-tech/BitBull.git"
BREW_INSTALL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[31mStopped:\033[0m %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --ask-keys) ASK_KEYS=1; shift ;;
    --no-keys) ASK_KEYS=0; shift ;; # the default now; kept so older instructions still work
    --browser) USE_APP=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,27p' "$0" 2>/dev/null || echo "See https://www.bitbull.tech/guide/mac"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
case "$RUNTIME" in colima|docker) ;; *) die "--runtime must be colima or docker" ;; esac
[ -n "$DIR" ] || die "--dir needs a folder"
case "$DIR" in "~"/*) DIR="$HOME/${DIR#\~/}" ;; esac

# Prompts come from the keyboard even when this script itself arrived on stdin.
if [ -r /dev/tty ] && : < /dev/tty 2>/dev/null; then TTY=/dev/tty; else TTY=""; fi
ask_yes() {
  # ask_yes "question"  → yes unless they answer n
  [ -n "$TTY" ] || return 0
  local a
  printf '%s [Y/n] ' "$1" > "$TTY"
  IFS= read -r a < "$TTY" || a=""
  case "$a" in n|N|no|No|NO) return 1 ;; *) return 0 ;; esac
}

# ---- 1. This Mac ----
[ "$(uname -s)" = Darwin ] || die "This installer is for macOS. Windows and Linux: https://www.bitbull.tech/guide/getting-started"
major="$(sw_vers -productVersion 2>/dev/null | cut -d. -f1)"
case "$major" in ''|*[!0-9]*) die "Couldn't read the macOS version." ;; esac
[ "$major" -ge 13 ] || die "BitBull needs macOS 13 (Ventura) or later; this Mac runs $(sw_vers -productVersion)."
say "Installing BitBull on macOS $(sw_vers -productVersion) ($(uname -m))"
note "BitBull goes in: $DIR"

# ---- 2. Homebrew, on the PATH now and in new Terminal windows ----
find_brew() {
  brew_bin=""
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { brew_bin="$b"; break; }; done
}
find_brew
NEW_BREW=0
if [ -z "$brew_bin" ]; then
  say "Homebrew (the Mac's standard installer for developer tools) isn't installed"
  note "Installing it now: BitBull uses it for git and Colima. It needs your Mac login password"
  note "once. Nothing shows while you type it; that is normal. Type it and press Return."
  # The password once, here; Homebrew's installer then runs without its own "Press RETURN" stop.
  if [ -n "$TTY" ]; then
    sudo -v < "$TTY" || die "Homebrew needs an administrator account on this Mac (System Settings → Users & Groups)."
  fi
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL "$BREW_INSTALL")" < "${TTY:-/dev/null}" \
    || die "Homebrew's installer didn't finish. Run this again once it does."
  find_brew
  [ -n "$brew_bin" ] || die "Homebrew installed, but its brew command wasn't found."
  NEW_BREW=1
fi
eval "$("$brew_bin" shellenv)"
# New Terminal windows need it too on Apple Silicon (/opt/homebrew is not on the default PATH;
# Intel's /usr/local/bin already is). Any existing shellenv line counts, whichever form Homebrew
# printed, so following Homebrew's own instructions too never gives two.
if [ "$brew_bin" = /opt/homebrew/bin/brew ] && ! grep -qs 'brew shellenv' "$HOME/.zprofile"; then
  printf '\n%s\n' 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"' >> "$HOME/.zprofile"
  note "Added Homebrew to ~/.zprofile, so new Terminal windows find it."
fi

# ---- 3. git (Apple's Command Line Tools arrive with Homebrew) ----
if ! git --version >/dev/null 2>&1; then
  say "Installing git"
  brew install git || die "Couldn't install git."
fi

# ---- 4. The code ----
if [ -d "$DIR/.git" ]; then
  say "Updating BitBull in $DIR"
  git -C "$DIR" pull --ff-only || die "Couldn't update $DIR (local changes?). Run 'git -C \"$DIR\" status' to see why."
elif [ -e "$DIR" ]; then
  die "$DIR already exists and isn't a BitBull download. Move it, or choose another folder with --dir."
else
  say "Downloading BitBull into $DIR"
  mkdir -p "$(dirname "$DIR")" || die "Couldn't create $(dirname "$DIR")"
  git clone "$REPO_URL" "$DIR" || die "Download failed. Check your internet connection and run this again."
fi
cd "$DIR" || die "Couldn't open $DIR"
[ -f scripts/bitbull-mac/setup.sh ] || die "$DIR doesn't look like BitBull (no scripts/bitbull-mac/setup.sh)."

# ---- 5. Keys, written into .env ----
if [ ! -f .env ]; then
  cp .env.example .env || die "Couldn't create .env"
  chmod 600 .env
fi

# The value .env has for a key now (empty, or a placeholder from .env.example, counts as missing).
env_value() {
  local line v=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$1="*) v="${line#*=}" ;; esac
  done < .env
  case "$v" in ''|*xxx*|*your-*|*changeme*) printf '' ;; *) printf '%s' "$v" ;; esac
}

# Set KEY=value in .env: the existing line is replaced, or one is added. Rewritten line by line in
# bash, so the value is never part of a command or a sed pattern.
env_set() {
  local key="$1" value="$2" line done=0 tmp
  tmp="$(mktemp "$DIR/.env.XXXXXX")" || die "Couldn't write .env"
  chmod 600 "$tmp"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) if [ "$done" = 0 ]; then printf '%s=%s\n' "$key" "$value"; done=1; fi ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < .env > "$tmp"
  [ "$done" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv -f "$tmp" .env || die "Couldn't write .env"
}

# ask_key KEY "what it is" "where to get it" ["sign-up page"] → asks (hidden) until a plausible
# value is pasted; typing o opens the sign-up page (or the key page) in the browser
ask_key() {
  local key="$1" v
  [ -n "$(env_value "$key")" ] && { note "$key: already set, kept."; return; }
  if [ "$ASK_KEYS" = 0 ] || [ -z "$TTY" ]; then
    note "$key: BitBull's first screen will ask for it."
    return
  fi
  local signup="${4:-$3}"
  printf '\n  \033[1m%s\033[0m: %s\n  Get it at %s\n' "$key" "$2" "$3" > "$TTY"
  [ "$signup" = "$3" ] || printf '  No account yet? Sign up free first: %s\n' "$signup" > "$TTY"
  printf '  Type o and press Return to open that in your browser.\n' > "$TTY"
  while :; do
    printf '  Paste it and press Return (it stays hidden): ' > "$TTY"
    IFS= read -rs v < "$TTY" || v=""
    printf '\n' > "$TTY"
    case "$v" in
      o|O)
        open "$signup" >/dev/null 2>&1 || printf '  Open %s in your browser.\n' "$signup" > "$TTY"
        [ "$signup" = "$3" ] || printf '  Once you are signed in, your key is at %s\n' "$3" > "$TTY"
        continue ;;
    esac
    # trim spaces a copy can bring along
    v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    if [ -z "$v" ]; then
      ask_yes "  Nothing was pasted. Skip $key for now?" && { MISSING=1; return; }
      continue
    fi
    case "$v" in
      *[!A-Za-z0-9._:/+=-]*) printf '  That has characters a key never has (a space or quote?). Copy it again.\n' > "$TTY"; continue ;;
    esac
    [ "${#v}" -ge 12 ] || { printf '  That looks too short for a key. Copy the whole key and try again.\n' > "$TTY"; continue; }
    env_set "$key" "$v"
    printf '  Saved.\n' > "$TTY"
    return
  done
}

say "Settings"
note "Kept in $DIR/.env on this Mac only, and never shown on screen."
MISSING=0
APP_TOKEN_NOW="$(env_value APP_TOKEN)"
if [ -z "$APP_TOKEN_NOW" ]; then
  env_set APP_TOKEN "$(openssl rand -hex 32)" || die "Couldn't make an APP_TOKEN"
  note "APP_TOKEN: made a strong one for you (it's your BitBull password; see below)."
else
  note "APP_TOKEN: already set, kept."
  # Kept even if weak: changing it would sign out every browser and script that uses it
  [ "${#APP_TOKEN_NOW}" -ge 32 ] || note "  It's short for a password (${#APP_TOKEN_NOW} characters). For a strong one: openssl rand -hex 32"
fi
ask_key SAYGM_API_KEY "one key for every AI model" "https://saygm.com"
ask_key DITTO_API_KEY "BitBull's long-term memory" "https://app.heyditto.ai/mcp" "https://www.bitbull.tech/ditto"

if [ "$START" = 0 ]; then
  say "Ready. To set up BitBull later:"
  note "cd \"$DIR\" && bash scripts/bitbull-mac/setup.sh"
  exit 0
fi
[ "$MISSING" = 0 ] || note "A key was skipped: BitBull's first screen will ask for it."

# ---- 6. Set up, start at login, open ----
say "Setting up BitBull (the first time takes about 10 minutes)"
if [ "$RUNTIME" = docker ]; then
  bash scripts/bitbull-mac/setup.sh --runtime docker || exit $?
else
  bash scripts/bitbull-mac/setup.sh || exit $?
fi
bash scripts/bitbull-mac/start.sh --install-at-login || exit $?

# ---- 7. The BitBull app (its own window and menu-bar icon), or the browser ----

# Download the app from BitBull's latest release and put it in Applications. Prints where it is
# and returns 0, or returns 1 (no release yet, no network, not the app we expect): the caller
# then falls back to the app already installed, or the browser.
install_app() {
  local tmp dmg mnt src id dest_dir dest
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/bitbull-app.XXXXXX")" || return 1
  dmg="$tmp/BitBull.dmg"
  mnt="$tmp/mnt"
  if ! curl -fsSL --retry 2 --max-time 300 -o "$dmg" "$APP_DMG_URL" 2>/dev/null; then rm -rf "$tmp"; return 1; fi
  mkdir -p "$mnt"
  if ! hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mnt" "$dmg" >/dev/null 2>&1; then rm -rf "$tmp"; return 1; fi
  src=""
  for a in "$mnt"/*.app; do [ -d "$a" ] && { src="$a"; break; }; done
  # only ever BitBull's own app
  id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$src/Contents/Info.plist" 2>/dev/null)"
  if [ -z "$src" ] || [ "$id" != "$APP_ID" ]; then hdiutil detach -quiet "$mnt" >/dev/null 2>&1; rm -rf "$tmp"; return 1; fi
  # /Applications when this account may write there (administrators), else your own Applications
  if [ -w /Applications ]; then dest_dir=/Applications; else dest_dir="$HOME/Applications"; mkdir -p "$dest_dir"; fi
  dest="$dest_dir/BitBull.app"
  osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
  rm -rf "$dest.new"
  if ditto "$src" "$dest.new" 2>/dev/null; then
    rm -rf "$dest" && mv "$dest.new" "$dest"
  else
    rm -rf "$dest.new"; dest=""
  fi
  hdiutil detach -quiet "$mnt" >/dev/null 2>&1
  rm -rf "$tmp"
  [ -n "$dest" ] && [ -d "$dest" ] || return 1
  printf '%s' "$dest"
}

# The app finds BitBull in the usual folders by itself; told where it is when it's elsewhere.
# Only written when the app has no settings yet, and only for a path JSON can hold as it is.
app_settings() {
  local dir="$HOME/Library/Application Support/$APP_ID" file
  file="$dir/bitbull-desktop.json"
  [ -f "$file" ] && return 0
  case "$DIR" in *\\*|*\"*) return 0 ;; esac
  mkdir -p "$dir" && printf '{\n  "repo": "%s",\n  "distro": "bitbull",\n  "port": 8787,\n  "auto_token": true,\n  "open_when_ready": true\n}\n' "$DIR" > "$file"
}

say "BitBull is running: http://localhost:8787"
app=""
if [ "$USE_APP" = 1 ]; then
  note "Getting the BitBull app..."
  app="$(install_app)" || app=""
  if [ -z "$app" ]; then
    # no download just now: use the app if it is already here
    for a in /Applications/BitBull.app "$HOME/Applications/BitBull.app"; do [ -d "$a" ] && { app="$a"; break; }; done
  fi
fi
if [ -n "$app" ]; then
  app_settings
  if open "$app" >/dev/null 2>&1; then
    note "BitBull is open in its own app ($app), signed in, with an icon in the menu bar."
    note "Its first screen asks for your SayGM key and Ditto sign-in. It also opens when you log in."
    note "Prefer a browser? http://localhost:8787 works too."
    note "If macOS says it can't check the app: right-click BitBull in Applications, choose Open, once."
  else
    app=""
  fi
fi

# The browser, when there is no app: opened signed in. A private page (readable only by you,
# gone in a few seconds) hands it the APP_TOKEN, so it is never on a command line and there is
# nothing to copy. BitBull takes it out of the address bar at once.
token="$(env_value APP_TOKEN)"
opened=0
[ -z "$app" ] || token=""
case "$token" in
  ''|*[!A-Za-z0-9._~+/=-]*) ;;
  *)
    page="$(mktemp "${TMPDIR:-/tmp}/bitbull-open.XXXXXX")" && mv "$page" "$page.html" && page="$page.html" && chmod 600 "$page" &&
      printf '<!doctype html><meta charset="utf-8"><title>Opening BitBull</title><script>location.replace("http://localhost:8787/#token=%s")</script>\n' "$token" > "$page" &&
      open "$page" >/dev/null 2>&1 && opened=1
    # removed even if this Terminal window is closed straight away
    ( trap '' HUP; sleep 8; rm -f "$page" ) >/dev/null 2>&1 &
    ;;
esac
if [ -n "$app" ]; then
  :
elif [ "$opened" = 1 ]; then
  [ "$USE_APP" = 0 ] || note "The BitBull app couldn't be downloaded just now, so BitBull is in your browser. Run this again later to get the app."
  note "It's open in your browser, signed in. Its first screen asks for your SayGM key and Ditto sign-in."
else
  open "http://localhost:8787" >/dev/null 2>&1 || true
  note "Sign in with your APP_TOKEN. To see it:   grep APP_TOKEN \"$DIR/.env\""
fi
note "On another browser or device, sign in with your APP_TOKEN:   grep APP_TOKEN \"$DIR/.env\""
note "Open a new Terminal window for later commands, or run:  cd \"$DIR\""
if [ "$NEW_BREW" = 1 ] && [ "$brew_bin" = /opt/homebrew/bin/brew ]; then
  note "To use brew in this same window now, paste:  eval \"\$(/opt/homebrew/bin/brew shellenv zsh)\""
fi
note "Guide: https://www.bitbull.tech/guide/mac"
