#!/bin/sh
# Read-only links from Windows folders into the GM sandbox. Runs as root in the gm distro;
# installed as /usr/local/sbin/gm-links by link.ps1 (and provision.sh).
#
#   gm-links add <name> '<Windows path>'   mount it read-only at /srv/gm-links/<name>
#   gm-links remove <name>
#   gm-links list
#   gm-links mount-all                     re-mount everything in /etc/gm-links (at boot)
#
# The gm distro has Windows drive automount switched off, so nothing on Windows is visible
# here except what is listed in /etc/gm-links, and each of those only:
#   ro       the kernel refuses every write, so files can't be changed, deleted or encrypted
#   noexec   nothing in it can be run directly
#   nosuid, nodev
# The gm-agent container sees /srv/gm-links at /links (read-only again, in compose).
# Changing links never happens from GM itself: only root in this distro can mount, and
# the container's uids are remapped to nobodies here.
set -eu
LINKS=/srv/gm-links
REG=/etc/gm-links

uid() {
  start=$(awk -F: '$1=="dockremap"{print $2}' /etc/subuid)
  [ -n "$start" ] || { echo "dockremap subuid range not found: is this the gm distro?" >&2; exit 1; }
  echo $((start + 1000))
}

do_mount() { # name winpath
  dir="$LINKS/$1"
  mkdir -p "$dir"
  chmod 755 "$LINKS" "$dir"
  if mountpoint -q "$dir"; then return 0; fi
  u=$(uid)
  # timeout: an unplugged drive must not hold up boot (docker starts after this)
  timeout 15 mount -t drvfs "$2" "$dir" -o "ro,noexec,nosuid,nodev,uid=$u,gid=$u,umask=222,fmask=333"
}

check_name() {
  case "$1" in
    ''|*[!a-z0-9-]*|-*) echo "name must be lowercase letters, digits and dashes" >&2; exit 2 ;;
  esac
  [ ${#1} -le 40 ] || { echo "name is too long (40 max)" >&2; exit 2; }
}

touch "$REG"
chmod 644 "$REG"
mkdir -p "$LINKS"

case "${1:-list}" in
  add)
    name="$2"; win="$3"
    check_name "$name"
    if grep -q "^$name	" "$REG"; then echo "a link called $name already exists" >&2; exit 3; fi
    do_mount "$name" "$win" || { rmdir "$LINKS/$name" 2>/dev/null || true; echo "could not mount $win" >&2; exit 4; }
    # prove it: a write must fail
    if touch "$LINKS/$name/.gm-write-test" 2>/dev/null; then
      rm -f "$LINKS/$name/.gm-write-test"; umount "$LINKS/$name"; rmdir "$LINKS/$name"
      echo "REFUSED: the mount was writable, so it has been removed" >&2; exit 5
    fi
    printf '%s\t%s\n' "$name" "$win" >> "$REG"
    echo "linked $name -> $win (read-only, verified)"
    ;;
  remove)
    name="$2"
    check_name "$name"
    if mountpoint -q "$LINKS/$name"; then umount "$LINKS/$name" || umount -l "$LINKS/$name"; fi
    rmdir "$LINKS/$name" 2>/dev/null || true
    grep -v "^$name	" "$REG" > "$REG.new" || true
    mv "$REG.new" "$REG"
    echo "removed $name"
    ;;
  list)
    while IFS='	' read -r name win; do
      [ -n "$name" ] || continue
      state=missing
      mountpoint -q "$LINKS/$name" && state=mounted
      printf '%-24s %-8s %s\n' "$name" "$state" "$win"
    done < "$REG"
    ;;
  mount-all)
    while IFS='	' read -r name win; do
      [ -n "$name" ] || continue
      do_mount "$name" "$win" || echo "gm-links: could not mount $name ($win)" >&2
    done < "$REG"
    ;;
  *)
    echo "usage: gm-links add <name> <windows-path> | remove <name> | list | mount-all" >&2; exit 2 ;;
esac
