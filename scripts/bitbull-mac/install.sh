#!/bin/bash
# BitBull on a Mac in one command. Paste this into Terminal (it works the same in zsh, the Mac's
# default shell, because it runs under bash however it is started):
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/bitbull-tech/BitBull/main/scripts/bitbull-mac/install.sh)"
#
# It takes care of the Terminal snags that trip people up on a Mac:
#   - Homebrew: installs it if missing (asking first) and puts it on your PATH, for this window and
#     for new ones (~/.zprofile), which Homebrew's installer leaves you to do by hand on Apple Silicon.
#   - git: Apple's Command Line Tools come with Homebrew; nothing else to install.
#   - Your keys: asked for here, with the typing hidden, and written into .env for you. No TextEdit,
#     so no "smart quotes" or rich text creeping into the file, and no hunting for a hidden file.
#     APP_TOKEN (your BitBull password) is made for you.
#   - Then the usual setup.sh and start.sh --install-at-login, and BitBull opens in your browser.
#
# Run it again any time: it updates the code (git pull), keeps the keys already in .env, and only
# asks for ones that are missing.
#
#   ... --dir ~/code/BitBull     where to put BitBull (default ~/BitBull)
#   ... --runtime docker         use the Docker Desktop / OrbStack you already run (default: Colima)
#   ... --no-keys                don't ask for keys (an AI agent filling .env itself uses this)
#   ... --no-start               stop after the keys; run setup.sh yourself later
#
# Written for the bash that ships with macOS (3.2). Prompts read from the terminal (/dev/tty), so
# `curl … | bash` works too. Keys are never printed, logged or passed on a command line.

set -u

DIR="$HOME/BitBull"
RUNTIME=colima
ASK_KEYS=1
START=1
REPO_URL="https://github.com/bitbull-tech/BitBull.git"
BREW_INSTALL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\n\033[31mStopped:\033[0m %s\n' "$1" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --no-keys) ASK_KEYS=0; shift ;;
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
brew_bin=""
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { brew_bin="$b"; break; }; done
if [ -z "$brew_bin" ]; then
  say "Homebrew (the Mac's standard installer for developer tools) isn't installed"
  note "BitBull uses it for git and Colima. Its installer will ask for your Mac login password;"
  note "nothing shows while you type it. That is normal: type it and press Return."
  ask_yes "Install Homebrew now?" || die "Homebrew is needed. Install it from https://brew.sh, then run this again."
  /bin/bash -c "$(curl -fsSL "$BREW_INSTALL")" < "${TTY:-/dev/null}" || die "Homebrew's installer didn't finish. Run this again once it does."
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { brew_bin="$b"; break; }; done
  [ -n "$brew_bin" ] || die "Homebrew installed, but its brew command wasn't found."
fi
eval "$("$brew_bin" shellenv)"
# New Terminal windows need it too (zsh reads ~/.zprofile; Apple Silicon's /opt/homebrew is not on
# the default PATH). Added once, and only the line Homebrew itself recommends.
line="eval \"\$($brew_bin shellenv)\""
if ! grep -qsF "$line" "$HOME/.zprofile"; then
  printf '\n%s\n' "$line" >> "$HOME/.zprofile"
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

# ask_key KEY "what it is" "where to get it" → asks (hidden) until a plausible value is pasted
ask_key() {
  local key="$1" v
  [ -n "$(env_value "$key")" ] && { note "$key: already set, kept."; return; }
  if [ "$ASK_KEYS" = 0 ] || [ -z "$TTY" ]; then
    note "$key: not set yet. Put it in $DIR/.env before starting BitBull."
    MISSING=1
    return
  fi
  printf '\n  \033[1m%s\033[0m: %s\n  Get it at %s\n' "$key" "$2" "$3" > "$TTY"
  while :; do
    printf '  Paste it and press Return (it stays hidden): ' > "$TTY"
    IFS= read -rs v < "$TTY" || v=""
    printf '\n' > "$TTY"
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

say "Your keys"
note "They go into $DIR/.env on this Mac only, and are never shown on screen."
MISSING=0
if [ -z "$(env_value APP_TOKEN)" ]; then
  env_set APP_TOKEN "$(openssl rand -hex 32)" || die "Couldn't make an APP_TOKEN"
  note "APP_TOKEN: made a strong one for you (it's your BitBull password; see below)."
else
  note "APP_TOKEN: already set, kept."
fi
ask_key SAYGM_API_KEY "one key for every AI model" "https://saygm.com"
ask_key DITTO_API_KEY "BitBull's long-term memory" "https://heyditto.ai"

if [ "$START" = 0 ]; then
  say "Keys done. To set up BitBull later:"
  note "cd \"$DIR\" && bash scripts/bitbull-mac/setup.sh"
  exit 0
fi
[ "$MISSING" = 0 ] || die "Some keys are still missing. When you have them, run this installer again: it only asks for the missing ones."

# ---- 6. Set up, start at login, open ----
say "Setting up BitBull (the first time takes about 10 minutes)"
if [ "$RUNTIME" = docker ]; then
  bash scripts/bitbull-mac/setup.sh --runtime docker || exit $?
else
  bash scripts/bitbull-mac/setup.sh || exit $?
fi
bash scripts/bitbull-mac/start.sh --install-at-login || exit $?

say "BitBull is running: http://localhost:8787"
note "Sign in with your APP_TOKEN. To see it:   grep APP_TOKEN \"$DIR/.env\""
note "Open a new Terminal window for later commands, or run:  cd \"$DIR\""
note "Guide: https://www.bitbull.tech/guide/mac"
open "http://localhost:8787" >/dev/null 2>&1 || true
