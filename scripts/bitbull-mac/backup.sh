#!/bin/bash
# Back up everything BitBull keeps (chats, projects, uploads, settings) to one file.
# Hippius only mirrors uploads; this is the copy of agent.db and the rest.
#
#   scripts/bitbull-mac/backup.sh
#   ... --to ~/Backups/BitBull     a different folder (default: ~/Documents/BitBull backups)
#   ... --keep 10                  keep the newest 10 backups there, delete older ones
#
# The file holds settings.local.json, so any keys you entered in the UI are in it: keep it
# private. BitBull keeps running; back up when it is idle.
#
# Restore (BitBull stopped):
#   mv ~/"Library/Application Support/BitBull/data" ~/"Library/Application Support/BitBull/data.old"
#   tar -xzf <backup>.tgz -C ~/"Library/Application Support/BitBull"
source "$(dirname "$0")/common.sh"

TO="$HOME/Documents/BitBull backups"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="${2:-}"; shift 2 ;;
    --keep) KEEP="${2:-0}"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done
case "$KEEP" in ''|*[!0-9]*) die "--keep takes a number" ;; esac
[ -d "$BB_DATA" ] || die "No BitBull data at $BB_DATA"

mkdir -p "$TO"
file="$TO/bitbull-data-$(date +%Y-%m-%d-%H%M).tgz"
say "Backing up $BB_DATA to $file"
# caches and engine sandboxes are rebuilt on start
if ! tar -czf "$file" -C "$BB_HOME" --exclude data/cache --exclude data/tmp --exclude data/opencode-sandbox/cache data; then
  rm -f "$file"
  die "backup failed"
fi
chmod 600 "$file"
size=$(wc -c < "$file" | tr -d ' ')
[ "$size" -ge 1024 ] || die "The backup is suspiciously small ($size bytes). Check that BitBull's data is at $BB_DATA."
say "Backed up: $file ($((size / 1048576)) MB)"
note "It contains any keys saved in the UI: keep it private."

if [ "$KEEP" -gt 0 ]; then
  # names sort by date; newest first, everything after the first $KEEP goes
  i=0
  # the glob sorts by name, which is by date: count down from the newest
  set -- "$TO"/bitbull-data-*.tgz
  for (( j = $#; j >= 1; j-- )); do
    old="${!j}"
    [ -f "$old" ] || continue
    i=$((i + 1))
    [ $i -le "$KEEP" ] && continue
    rm -f "$old" && note "Removed old backup $(basename "$old")"
  done
fi
