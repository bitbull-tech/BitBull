#!/bin/bash
# Install or update the BitBull app (BitBull in its own window, with a menu-bar icon) from
# BitBull's latest release on GitHub, into Applications.
#
#   scripts/bitbull-mac/app.sh             install it, or update it if a newer release is out;
#                                          an open app is asked to quit, replaced, and reopened
#   scripts/bitbull-mac/app.sh --from-app  the app itself is running this (its Update button):
#                                          the new version is put in place without closing it,
#                                          and the app restarts itself when the update finishes
#   scripts/bitbull-mac/app.sh --no-open   don't open the app afterwards
#
# Exit code 0: the app is installed and current. 1: it couldn't be (no release yet, no network,
# or the download wasn't BitBull's app); whatever was installed before is left as it was.
source "$(dirname "$0")/common.sh"

FROM_APP=0
OPEN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --from-app) FROM_APP=1; OPEN=0; shift ;;
    --no-open) OPEN=0; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

APP_ID="io.bitbull.desktop"
RELEASES="https://github.com/bitbull-tech/BitBull/releases"
# which release the installed app came from (the app's own version number doesn't change per release)
MARK="$HOME/Library/Application Support/$APP_ID/installed-release"

bb_check_macos

installed=""
for a in /Applications/BitBull.app "$HOME/Applications/BitBull.app"; do [ -d "$a" ] && { installed="$a"; break; }; done

# The latest release's tag, from where "latest" redirects to (no API, no token)
latest="$(curl -fsS -o /dev/null -w '%{redirect_url}' --max-time 20 "$RELEASES/latest" 2>/dev/null)"
latest="${latest##*/}"
case "$latest" in v[0-9]*) ;; *) latest="" ;; esac
case "$latest" in *[!A-Za-z0-9._-]*) latest="" ;; esac

have="$(cat "$MARK" 2>/dev/null)"
if [ -n "$installed" ] && { [ -z "$latest" ] || [ "$have" = "$latest" ]; }; then
  [ -n "$latest" ] && note "The BitBull app is up to date ($latest)." || note "Couldn't check for a newer BitBull app just now; keeping the one installed."
  [ "$OPEN" = 0 ] || open "$installed" >/dev/null 2>&1 || true
  exit 0
fi
[ -n "$latest" ] || { warn "Couldn't reach BitBull's releases to get the app."; exit 1; }

say "Getting the BitBull app ($latest)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/bitbull-app.XXXXXX")" || exit 1
mnt="$tmp/mnt"
cleanup() { hdiutil detach -quiet "$mnt" >/dev/null 2>&1; rm -rf "$tmp"; }
trap cleanup EXIT
curl -fsSL --retry 2 --max-time 300 -o "$tmp/BitBull.dmg" "$RELEASES/download/$latest/BitBull-macos.dmg" 2>/dev/null || { warn "The $latest release has no BitBull-macos.dmg yet (it is added a few minutes after a release is made)."; exit 1; }
mkdir -p "$mnt"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mnt" "$tmp/BitBull.dmg" >/dev/null 2>&1 || { warn "The downloaded app couldn't be opened."; exit 1; }
src=""
for a in "$mnt"/*.app; do [ -d "$a" ] && { src="$a"; break; }; done
# only ever BitBull's own app
id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$src/Contents/Info.plist" 2>/dev/null)"
[ -n "$src" ] && [ "$id" = "$APP_ID" ] || { warn "The download wasn't the BitBull app; nothing was installed."; exit 1; }

# where it goes: where it already is, else /Applications when this account may write there
# (administrators), else your own Applications folder
if [ -n "$installed" ]; then dest="$installed"
elif [ -w /Applications ]; then dest=/Applications/BitBull.app
else mkdir -p "$HOME/Applications"; dest="$HOME/Applications/BitBull.app"; fi

# the new copy next to the old one first, so a failed copy leaves the old app untouched
rm -rf "$dest.new"
ditto "$src" "$dest.new" 2>/dev/null || { rm -rf "$dest.new"; warn "Couldn't copy the app into $(dirname "$dest")."; exit 1; }

app_running() { pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1; }
was_running=0
if app_running; then
  was_running=1
  if [ "$FROM_APP" = 0 ]; then
    # ask it to quit, give it a few seconds, then insist: an app that is being replaced must not
    # be left half-running with its icon stuck in the Dock
    note "Closing the BitBull app to update it (BitBull itself keeps running)..."
    osascript -e "tell application id \"$APP_ID\" to quit" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do app_running || break; sleep 0.5; done
    if app_running; then pkill -f "$dest/Contents/MacOS/" >/dev/null 2>&1 || true; sleep 1; fi
    if app_running; then pkill -9 -f "$dest/Contents/MacOS/" >/dev/null 2>&1 || true; sleep 1; fi
  fi
fi

# swap: the running app (when it is the one updating) keeps working from the old files until it restarts
rm -rf "$dest.old"
[ ! -d "$dest" ] || mv "$dest" "$dest.old" || { rm -rf "$dest.new"; warn "Couldn't replace $dest."; exit 1; }
if ! mv "$dest.new" "$dest"; then
  [ ! -d "$dest.old" ] || mv "$dest.old" "$dest"
  warn "Couldn't put the new app in place; the old one is back."
  exit 1
fi
rm -rf "$dest.old"
mkdir -p "$(dirname "$MARK")" && printf '%s\n' "$latest" > "$MARK"
say "The BitBull app is now $latest ($dest)"

if [ "$FROM_APP" = 1 ]; then
  # the launcher sees this line and restarts the app once the whole update has finished
  [ "$was_running" = 0 ] || echo "BITBULL-APP-UPDATED"
elif [ "$OPEN" = 1 ] || [ "$was_running" = 1 ]; then
  open "$dest" >/dev/null 2>&1 || true
fi
