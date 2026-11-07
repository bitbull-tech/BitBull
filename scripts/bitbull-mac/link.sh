#!/bin/bash
# Give BitBull read-only access to a folder on this Mac.
#
#   scripts/bitbull-mac/link.sh add ~/Documents/Horner            link a folder
#   ... add ~/code/thing --name thing                              choose the name BitBull shows
#   ... add <folder> --hide            a copy WITHOUT .env, keys and wallets (recommended when found)
#   ... add <folder> --allow-secrets   a copy of everything, keys included (you are sure)
#   ... refresh <name>                 copy again (after a fresh scan for secrets)
#   ... remove <name>
#   ... list                           name, state, mode, folder (tab-separated)
#
# The agent sees the folder at /links/<name>, read-only. On a Mac a link is always a COPY kept in
# BitBull's folder (Windows mounts the folder itself): the VM never needs to see the rest of your
# Mac, and nothing the agent does can reach the original. After changing files, Refresh it
# (Settings → Folders in BitBull, or this script). New links and removals show up straight away;
# BitBull doesn't restart.
#
# A linked folder is readable from EVERY chat, and anything in it may be sent to the model. So a
# folder holding keys, passwords or wallets is not copied as it is: exit code 3 means some were
# found (re-run with --hide or --allow-secrets), 4 means it is BitBull's own repo (only --hide).
# The BitBull app's link helper asks you which, in a dialog, and re-runs this script.
source "$(dirname "$0")/common.sh"

REG="$BB_HOME/links.tsv"
MAX_KB=$((20 * 1024 * 1024))   # 20 GB: a copy that large belongs on a real mount, not here
mkdir -p "$BB_LINKS"
[ -f "$REG" ] || : > "$REG"

valid_name() { case "$1" in ''|-*|*[!a-z0-9-]*) return 1 ;; esac; [ ${#1} -le 40 ]; }

# name<TAB>mode<TAB>folder, mode = filtered (secrets left out) | all
reg_get() { awk -F '\t' -v n="$1" '$1 == n { print; exit }' "$REG"; }
reg_put() { reg_del "$1"; printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$REG"; }
reg_del() { local t="$REG.tmp"; awk -F '\t' -v n="$1" '$1 != n' "$REG" > "$t" && mv "$t" "$REG"; }

# Places that are never linked at all
check_linkable() {
  local full="$1" d
  case "$full" in
    /|/System|/System/*|/Library|/Library/*|/Applications|/Applications/*|/usr|/usr/*|/bin|/bin/*|/sbin|/sbin/*|/private|/private/*|/etc|/etc/*|/var|/var/*|/Volumes|/Users)
      die "Refusing to link a system folder ($full)." ;;
  esac
  [ "$full" = "$HOME" ] && die "Refusing to link your whole home folder. Link the folder you need."
  for d in "$HOME/Library" "$HOME/.ssh" "$HOME/.gnupg" "$HOME/.aws" "$HOME/.config" "$BB_HOME"; do
    case "$full" in "$d"|"$d"/*) die "Refusing to link a private or app-data folder ($full)." ;; esac
  done
  case "$full" in "$BB_REPO/data"|"$BB_REPO/data/"*) die "Refusing to link BitBull's own data folder." ;; esac
}

SECRET_NAMES=".env .ssh .aws .azure .gnupg .kube .docker .hippius .bittensor .npmrc .pypirc .netrc .git-credentials id_rsa id_dsa id_ecdsa id_ed25519 credentials credentials.json secrets.json wallet.dat cookies key4.db logins.json settings.local.json"
SECRET_GLOBS='*.pem *.key *.pfx *.p12 *.ppk *.jks *.keystore *.kdbx *.ovpn *.wallet wallet*.json *seed*.txt *mnemonic* .env.* coldkey* hotkey* id_*'

# Everything in a folder that looks like a key, password store or wallet, one relative path per
# line, into $HIDE (a file). Paths find can't read are added too: a copy can't include what
# wasn't checked. Sets IS_REPO=1 for BitBull's own repo (adds its .env, data, .gmtmp, links).
scan() {
  local full="$1" errs args=() n g
  HIDE="$(mktemp "${TMPDIR:-/tmp}/bitbull-hide.XXXXXX")"
  errs="$(mktemp "${TMPDIR:-/tmp}/bitbull-scan.XXXXXX")"
  say "Checking $full for keys and wallets"
  args=(-iname "login data")
  # word-splitting the lists on purpose; set -f keeps the shell from expanding the globs here
  set -f
  for n in $SECRET_NAMES; do args+=(-o -iname "$n"); done
  for g in $SECRET_GLOBS; do args+=(-o -iname "$g"); done
  set +f
  find "$full" \( "${args[@]}" \) ! -iname '*.example' ! -iname '*.sample' ! -iname '*.template' -print 2>"$errs" |
    while IFS= read -r p; do printf '%s\n' "${p#"$full"/}"; done > "$HIDE"
  # "find: /path: Permission denied" -> that path, relative
  sed -n 's/^find: \(.*\): Permission denied$/\1/p' "$errs" | while IFS= read -r p; do
    case "$p" in "$full"/*) printf '%s\n' "${p#"$full"/}" ;; esac
  done >> "$HIDE"
  rm -f "$errs"
  IS_REPO=0
  if [ "$full" = "$BB_REPO" ] || case "$BB_REPO" in "$full"/*) true ;; *) false ;; esac; then
    IS_REPO=1
    local prefix="${BB_REPO#"$full"}"
    prefix="${prefix#/}"
    [ -n "$prefix" ] && prefix="$prefix/"
    printf '%s\n' "${prefix}.env" "${prefix}data" "${prefix}.gmtmp" "${prefix}links" >> "$HIDE"
  else
    case "$full" in "$BB_REPO"/*) IS_REPO=1 ;; esac
  fi
  grep -v '^$' "$HIDE" | sort -u > "$HIDE.sorted"
  mv "$HIDE.sorted" "$HIDE"
}

show_found() {
  local count
  count=$(wc -l < "$HIDE" | tr -d ' ')
  echo "These look like keys, passwords or wallets (or couldn't be checked):"
  head -n 15 "$HIDE" | sed 's/^/  /'
  [ "$count" -gt 15 ] && echo "  ... and $((count - 15)) more"
  return 0
}

# Copy $1 to links/$2, leaving out the paths in $HIDE (and the same patterns anywhere) unless
# mode is "all". Made world-readable inside BitBull's private folder (700), so the container's
# user can read it whatever the original permissions were. Swapped in whole, never half-copied.
copy_in() {
  local full="$1" name="$2" mode="$3" ex kb
  kb=$(du -sk "$full" 2>/dev/null | awk '{ print $1 }')
  [ -n "$kb" ] && [ "$kb" -gt "$MAX_KB" ] && die "$full is $((kb / 1048576)) GB: too big to keep a copy of. Link a smaller folder."
  ex="$(mktemp "${TMPDIR:-/tmp}/bitbull-exclude.XXXXXX")"
  if [ "$mode" = filtered ]; then
    # anchored to the folder; rsync treats [ * ? \ as wildcards, so escape them
    sed -e 's/[][*?\\]/\\&/g' -e 's|^|/|' "$HIDE" > "$ex"
    set -f
    for n in $SECRET_NAMES $SECRET_GLOBS; do printf '%s\n' "$n" >> "$ex"; done
    set +f
    printf '%s\n' 'Login Data' 'login data' >> "$ex"
  fi
  printf '%s\n' '.DS_Store' >> "$ex"
  rm -rf "$BB_LINKS/.$name.new"
  if ! rsync -a --delete --exclude-from="$ex" --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r "$full/" "$BB_LINKS/.$name.new/"; then
    rm -rf "$BB_LINKS/.$name.new" "$ex"
    die "copy failed"
  fi
  rm -f "$ex"
  rm -rf "$BB_LINKS/.$name.old"
  [ -e "$BB_LINKS/$name" ] && mv "$BB_LINKS/$name" "$BB_LINKS/.$name.old"
  mv "$BB_LINKS/.$name.new" "$BB_LINKS/$name"
  rm -rf "$BB_LINKS/.$name.old"
}

cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  list)
    while IFS="$(printf '\t')" read -r name mode path; do
      [ -n "$name" ] || continue
      state=missing
      [ -d "$BB_LINKS/$name" ] && state=mounted
      printf '%s\t%s\t%s\t%s\n' "$name" "$state" "$mode" "$path"
    done < "$REG"
    ;;

  remove)
    name="$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')"
    valid_name "$name" || die "bad name"
    [ -n "$(reg_get "$name")" ] || [ -d "$BB_LINKS/$name" ] || die "No link called $name."
    rm -rf "${BB_LINKS:?}/$name"
    reg_del "$name"
    say "Removed $name. BitBull can no longer see it."
    ;;

  refresh)
    name="$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z')"
    valid_name "$name" || die "bad name"
    row="$(reg_get "$name")"
    [ -n "$row" ] || die "No link called $name."
    mode="$(printf '%s' "$row" | cut -f2)"
    full="$(printf '%s' "$row" | cut -f3-)"
    [ -d "$full" ] || die "The folder is gone: $full"
    scan "$full"
    say "Refreshing $name from $full ($(wc -l < "$HIDE" | tr -d ' ') path(s) hidden)"
    copy_in "$full" "$name" "$mode"
    rm -f "$HIDE"
    say "Refreshed. BitBull sees the new copy now."
    ;;

  add)
    target="" name="" chosen=0 hide=0 allow=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) name="${2:-}"; chosen=1; shift 2 ;;
        --hide) hide=1; shift ;;
        --allow-secrets) allow=1; shift ;;
        -*) die "Unknown option: $1" ;;
        *) target="$1"; shift ;;
      esac
    done
    [ -n "$target" ] || die "Which folder? link.sh add <folder>"
    [ -d "$target" ] || die "Not a folder: $target"
    full="$(cd "$target" && pwd -P)" || die "Can't open $target"
    check_linkable "$full"
    scan "$full"
    found=$(wc -l < "$HIDE" | tr -d ' ')
    mode=all
    if [ "$IS_REPO" = 1 ]; then
      [ "$allow" = 1 ] && [ "$hide" = 0 ] && die "BitBull's own repo can only be linked with its secrets hidden (--hide)."
      if [ "$hide" = 0 ]; then
        show_found
        die "This is BitBull's own repo (or contains it). It can be linked as a copy without .env, data and the files above: re-run with --hide." 4
      fi
      mode=filtered
    elif [ "$found" -gt 0 ]; then
      if [ "$hide" = 1 ]; then
        mode=filtered
      elif [ "$allow" = 0 ]; then
        show_found
        die "Not linked. Re-run with --hide to link a copy without these (recommended), or --allow-secrets to copy everything." 3
      fi
    elif [ "$hide" = 1 ]; then
      mode=filtered
    fi

    [ -n "$name" ] || name="$(basename "$full")"
    name="$(printf '%s' "$name" | tr 'A-Z' 'a-z' | sed -e 's/[^a-z0-9][^a-z0-9]*/-/g' -e 's/^-*//' -e 's/-*$//' | cut -c1-36 | sed 's/-*$//')"
    [ -n "$name" ] || name=folder
    if [ -n "$(reg_get "$name")" ] || [ -e "$BB_LINKS/$name" ]; then
      [ "$chosen" = 1 ] && die "A link called $name already exists. Remove it first, or choose another --name."
      n=2
      while [ -n "$(reg_get "$name-$n")" ] || [ -e "$BB_LINKS/$name-$n" ]; do n=$((n + 1)); done
      name="$name-$n"
    fi
    if [ "$mode" = filtered ]; then
      say "Linking $full as /links/$name: a read-only copy without $found hidden path(s)"
    else
      say "Linking $full as /links/$name: a read-only copy"
    fi
    copy_in "$full" "$name" "$mode"
    reg_put "$name" "$mode" "$full"
    rm -f "$HIDE"
    echo
    echo "BITBULL-LINK-NAME: $name"
    say "Linked. In BitBull: the folder button in the chat box → Linked folders → $name."
    note "It is a copy: after changing files, press Refresh in Settings → Folders."
    ;;

  *)
    sed -n '2,23p' "$0"
    exit 2
    ;;
esac
