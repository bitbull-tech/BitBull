#!/bin/bash
# Update BitBull: get the latest code from GitHub, then rebuild from it (deploy.sh).
# Your chats, files and .env are not touched.
#
#   scripts/bitbull-mac/update.sh             nothing to rebuild if you already have the latest and it is running
#   scripts/bitbull-mac/update.sh --force     rebuild even so
#   scripts/bitbull-mac/update.sh --from-app  the BitBull app's Update button: the app is updated
#                                             too, in place, and restarts itself afterwards
#
# The BitBull app is updated as well, when it is installed and a newer release is out.
source "$(dirname "$0")/common.sh"

FORCE=0
FROM_APP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --from-app) FROM_APP=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

# The app, when it is installed: brought up to the latest release. Never fatal: BitBull itself
# is what matters, and the app can be updated on the next run.
update_app() {
  [ -d /Applications/BitBull.app ] || [ -d "$HOME/Applications/BitBull.app" ] || return 0
  if [ "$FROM_APP" = 1 ]; then bash "$BB_SCRIPTS/app.sh" --from-app || true
  else bash "$BB_SCRIPTS/app.sh" --no-open || true; fi
}

bb_check_macos
command -v git >/dev/null 2>&1 || die "git isn't installed. With Homebrew: brew install git"
[ -d "$BB_REPO/.git" ] || die "$BB_REPO isn't a git download of BitBull, so it can't be updated this way. Download it again (https://www.bitbull.tech/guide/mac)."

before="$(git -C "$BB_REPO" rev-parse HEAD 2>/dev/null)"
say "Getting the latest BitBull from GitHub"
# fast-forward only: local changes or commits are never overwritten or merged behind your back
git -C "$BB_REPO" pull --ff-only || die "Couldn't update the code in $BB_REPO. If you changed files there, see: git -C \"$BB_REPO\" status"
after="$(git -C "$BB_REPO" rev-parse HEAD 2>/dev/null)"

# what is running now was built from the commit in build-info.json (deploy.sh writes it)
built="$(sed -n 's/.*"commit":"\([A-Za-z0-9]*\)".*/\1/p' "$BB_APP/build-info.json" 2>/dev/null)"
if [ "$FORCE" = 0 ] && [ "$before" = "$after" ] && [ -n "$built" ] && [ "${after#"$built"}" != "$after" ] && bb_health; then
  say "BitBull is already up to date ($(git -C "$BB_REPO" rev-parse --short HEAD)) and running."
  update_app
  exit 0
fi

[ "$before" = "$after" ] || note "now on $(git -C "$BB_REPO" rev-parse --short HEAD)"
bash "$BB_SCRIPTS/deploy.sh" || exit $?
update_app
say "Updated."
