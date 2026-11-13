#!/bin/bash
# Update BitBull: get the latest code from GitHub, then rebuild from it (deploy.sh).
# Your chats, files and .env are not touched.
#
#   scripts/bitbull-mac/update.sh          nothing to do if you already have the latest and it is running
#   scripts/bitbull-mac/update.sh --force  rebuild even so
source "$(dirname "$0")/common.sh"

FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  '') ;;
  -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
  *) die "Unknown option: $1 (see --help)" ;;
esac

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
  say "Already up to date ($(git -C "$BB_REPO" rev-parse --short HEAD)) and running. Nothing to do."
  exit 0
fi

[ "$before" = "$after" ] || note "now on $(git -C "$BB_REPO" rev-parse --short HEAD)"
bash "$BB_SCRIPTS/deploy.sh" || exit $?
say "Updated. If the BitBull app itself has a newer version, it is at https://github.com/bitbull-tech/BitBull/releases/latest"
