#!/bin/sh
# Read-only links from Windows folders into the GM sandbox. Runs as root in the gm distro;
# installed as /usr/local/sbin/gm-links by link.ps1 (and provision.sh).
#
#   gm-links add <name> '<Windows path>'          live: the folder itself, read-only
#   gm-links add-filtered <name> '<Windows path>' filtered: a read-only copy WITHOUT the paths
#                                                 listed on stdin (keys, .env, wallets ...)
#   gm-links refresh <name>                       filtered only: re-copy (new hide list on stdin)
#   gm-links remove <name>
#   gm-links list
#   gm-links mount-all                            bring everything back (at boot)
#
# The gm distro has Windows drive automount switched off, so nothing on Windows is visible
# here except what is listed in /etc/gm-links. The gm-agent container sees /srv/gm-links at
# /links (read-only again, in compose); nothing else under /srv is visible to it.
#
# live      drvfs mount at /srv/gm-links/<name>: ro, noexec, nosuid, nodev. The kernel refuses
#           every write, so files can't be changed, deleted or encrypted.
# filtered  for folders that hold secrets. Hiding files inside a live Windows mount isn't
#           reliable (Windows names are case-insensitive and have 8.3 short aliases, so a
#           hidden ".env" could still be opened as ".ENV" or "ENV~1"). So instead the folder is
#           mounted read-only in a root-only place (/srv/gm-src, never visible to GM), copied
#           with rsync to /srv/gm-mirrors/<name> leaving the hidden paths out, unmounted again,
#           and the copy is bound read-only into /srv/gm-links/<name>. A hidden file is
#           simply not there. The copy changes only when you press Refresh (link.ps1 -Refresh),
#           which re-scans the folder on Windows first; boot never re-copies.
#
# Changing links never happens from GM itself: only root in this distro can mount, and the
# container's uids are remapped to nobodies here.
set -eu
LINKS=/srv/gm-links
SRC=/srv/gm-src
MIRRORS=/srv/gm-mirrors
REG=/etc/gm-links
HIDE=/etc/gm-links.d

uid() {
  start=$(awk -F: '$1=="dockremap"{print $2}' /etc/subuid)
  [ -n "$start" ] || { echo "dockremap subuid range not found: is this the gm distro?" >&2; exit 1; }
  echo $((start + 1000))
}

check_name() {
  case "$1" in
    ''|*[!a-z0-9-]*|-*) echo "name must be lowercase letters, digits and dashes" >&2; exit 2 ;;
  esac
  [ ${#1} -le 40 ] || { echo "name is too long (40 max)" >&2; exit 2; }
}

drvfs() { # winpath target
  u=$(uid)
  # timeout: an unplugged drive must not hold up boot (docker starts after this)
  timeout 15 mount -t drvfs "$1" "$2" -o "ro,noexec,nosuid,nodev,uid=$u,gid=$u,umask=222,fmask=333"
}

mount_live() { # name winpath
  dir="$LINKS/$1"
  mkdir -p "$dir"; chmod 755 "$LINKS" "$dir"
  mountpoint -q "$dir" && return 0
  drvfs "$2" "$dir"
}

# stdin: one path per line, relative to the folder, as found by link.ps1. Every line becomes an
# anchored rsync exclude ("/path"), so no line can act as a filter rule. Wildcards in a name only
# ever hide more.
save_hide() { # name
  mkdir -p "$HIDE"; chmod 700 "$HIDE"
  tr -d '\r' | awk 'length($0) > 0 && $0 !~ /(^|\/)\.\.(\/|$)/ { sub(/^\/+/, ""); print "/" $0 }' > "$HIDE/$1.exclude"
  chmod 600 "$HIDE/$1.exclude"
}

copy_filtered() { # name winpath
  src="$SRC/$1"; mirror="$MIRRORS/$1"
  mkdir -p "$SRC" "$MIRRORS" "$src" "$mirror"
  chmod 700 "$SRC"; chmod 755 "$MIRRORS" "$mirror"
  mountpoint -q "$src" || drvfs "$2" "$src"
  # --delete-excluded: a file hidden now disappears from an older copy too
  rc=0
  # Built-in rules on top of the exact paths found on Windows: common secret names anywhere
  # (templates like .env.example stay), and dependency/cache folders that would only bloat it.
  rsync -rlt \
    --include=.env.example --include=.env.sample --include=.env.template \
    --exclude=.env --exclude='.env.*' --exclude=.ssh --exclude=.aws --exclude=.azure --exclude=.gnupg \
    --exclude=.kube --exclude=.docker --exclude=.hippius --exclude=.bittensor \
    --exclude='id_rsa*' --exclude='id_dsa*' --exclude='id_ecdsa*' --exclude='id_ed25519*' \
    --exclude='*.pem' --exclude='*.key' --exclude='*.pfx' --exclude='*.p12' --exclude='*.ppk' --exclude='*.jks' \
    --exclude='*.keystore' --exclude='*.kdbx' --exclude='*.ovpn' --exclude='*.wallet' --exclude='wallet*.json' \
    --exclude='*seed*.txt' --exclude='*mnemonic*' --exclude='coldkey*' --exclude='hotkey*' \
    --exclude=.npmrc --exclude=.pypirc --exclude=.netrc --exclude=.git-credentials --exclude=credentials \
    --exclude=credentials.json --exclude=secrets.json --exclude=wallet.dat --exclude=key4.db --exclude=logins.json \
    --exclude=settings.local.json --exclude='Login Data' --exclude=Cookies \
    --exclude=node_modules --exclude=.venv --exclude=venv --exclude=__pycache__ --exclude=.cache \
    --delete --delete-excluded --safe-links --no-devices --no-specials \
    --chmod=D755,F644 --exclude-from="$HIDE/$1.exclude" "$src/" "$mirror/" || rc=$?
  umount "$src" || umount -l "$src"
  rmdir "$src" 2>/dev/null || true
  # 23/24 = some files vanished or couldn't be read mid-copy: the copy is still usable
  [ "$rc" -eq 0 ] || [ "$rc" -eq 23 ] || [ "$rc" -eq 24 ] || { echo "copy failed (rsync $rc)" >&2; return 1; }
  chown -R root:root "$mirror"
}

bind_filtered() { # name
  dir="$LINKS/$1"
  mkdir -p "$dir"; chmod 755 "$LINKS" "$dir"
  mountpoint -q "$dir" && return 0
  mount --bind "$MIRRORS/$1" "$dir"
  mount -o remount,bind,ro,noexec,nosuid,nodev "$dir"
}

verify_ro() { # name
  if touch "$LINKS/$1/.gm-write-test" 2>/dev/null; then
    rm -f "$LINKS/$1/.gm-write-test"
    umount -R "$LINKS/$1" 2>/dev/null || true
    echo "REFUSED: the link was writable, so it has been removed" >&2
    return 1
  fi
}

mode_of() { awk -F'\t' -v n="$1" '$1==n { print ($3 == "" ? "live" : $3) }' "$REG"; }
win_of() { awk -F'\t' -v n="$1" '$1==n { print $2 }' "$REG"; }

touch "$REG"; chmod 644 "$REG"
mkdir -p "$LINKS"

case "${1:-list}" in
  add|add-filtered)
    cmd="$1"; name="$2"; win="$3"
    check_name "$name"
    if grep -q "^$name	" "$REG"; then echo "a link called $name already exists" >&2; exit 3; fi
    if [ "$cmd" = add ]; then
      mode=live
      mount_live "$name" "$win" || { rmdir "$LINKS/$name" 2>/dev/null || true; echo "could not mount $win" >&2; exit 4; }
    else
      mode=filtered
      save_hide "$name"
      if ! copy_filtered "$name" "$win" || ! bind_filtered "$name"; then
        umount -R "$LINKS/$name" 2>/dev/null || true; rm -rf "$MIRRORS/$name" "$HIDE/$name.exclude"; rmdir "$LINKS/$name" 2>/dev/null || true
        echo "could not copy $win" >&2; exit 4
      fi
    fi
    verify_ro "$name" || { rm -rf "$MIRRORS/$name"; exit 5; }
    printf '%s\t%s\t%s\n' "$name" "$win" "$mode" >> "$REG"
    if [ "$mode" = filtered ]; then
      echo "linked $name -> $win (filtered copy, read-only, verified; $(wc -l < "$HIDE/$name.exclude") path(s) hidden)"
    else
      echo "linked $name -> $win (read-only, verified)"
    fi
    ;;
  refresh)
    name="$2"
    check_name "$name"
    [ "$(mode_of "$name")" = filtered ] || { echo "$name is not a filtered link (live links are always current)" >&2; exit 2; }
    save_hide "$name"
    copy_filtered "$name" "$(win_of "$name")"
    echo "refreshed $name ($(wc -l < "$HIDE/$name.exclude") path(s) hidden)"
    ;;
  remove)
    name="$2"
    check_name "$name"
    umount -R "$LINKS/$name" 2>/dev/null || umount -l "$LINKS/$name" 2>/dev/null || true
    rmdir "$LINKS/$name" 2>/dev/null || true
    rm -rf "${MIRRORS:?}/$name" "$HIDE/$name.exclude"
    grep -v "^$name	" "$REG" > "$REG.new" || true
    mv "$REG.new" "$REG"
    echo "removed $name"
    ;;
  list)
    while IFS='	' read -r name win mode; do
      [ -n "$name" ] || continue
      state=missing
      mountpoint -q "$LINKS/$name" && state=mounted
      printf '%-24s %-8s %-8s %s\n' "$name" "$state" "${mode:-live}" "$win"
    done < "$REG"
    ;;
  mount-all)
    while IFS='	' read -r name win mode; do
      [ -n "$name" ] || continue
      if [ "${mode:-live}" = filtered ]; then
        # the existing copy only: re-copying needs a fresh scan for secrets on Windows
        [ -d "$MIRRORS/$name" ] && bind_filtered "$name" || echo "gm-links: no copy for $name" >&2
      else
        mount_live "$name" "$win" || echo "gm-links: could not mount $name ($win)" >&2
      fi
    done < "$REG"
    ;;
  *)
    echo "usage: gm-links add|add-filtered <name> <windows-path> | refresh <name> | remove <name> | list | mount-all" >&2; exit 2 ;;
esac
