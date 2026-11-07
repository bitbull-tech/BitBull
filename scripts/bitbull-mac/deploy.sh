#!/bin/bash
# Ship the code from this checkout into BitBull's folder and rebuild the containers.
# Your chats and files (~/Library/Application Support/BitBull/data) are not touched.
#
#   scripts/bitbull-mac/deploy.sh
source "$(dirname "$0")/common.sh"

bb_check_macos
[ -f "$BB_REPO/.env" ] || die "No .env in $BB_REPO (copy .env.example and fill it in)."
mkdir -p "$BB_APP" "$BB_DATA" "$BB_LINKS"

say "Copying code into $BB_APP"
# The same things Windows leaves out: data, dependencies, builds, git, the desktop app, Claude exports.
rsync -a --delete \
  --exclude '/data' --exclude '/links' --exclude '/.git' --exclude '/desktop' --exclude '/claude-export' --exclude '/.gmtmp' \
  --exclude 'node_modules' --exclude 'dist' --exclude '.DS_Store' \
  "$BB_REPO/" "$BB_APP/" || die "copy failed"
# a .env saved on Windows has CRLF line ends, which docker compose reads into the values
tr -d '\r' < "$BB_REPO/.env" > "$BB_APP/.env"
chmod 600 "$BB_APP/.env"

# What this build came from: the image has no .git, so /api/health and the launcher read it here
sha="$(git -C "$BB_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
branch="$(git -C "$BB_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
when="$(git -C "$BB_REPO" log -1 --format=%cI 2>/dev/null || true)"
dirty=false
[ -n "$(git -C "$BB_REPO" status --porcelain 2>/dev/null)" ] && dirty=true
case "$sha$branch" in *[!A-Za-z0-9._/-]*) sha=unknown; branch=unknown ;; esac
case "$when" in *[!0-9TZ:+.-]*) when="" ;; esac
printf '{"commit":"%s","branch":"%s","committed":"%s","dirty":%s,"deployedAt":"%s"}\n' \
  "$sha" "$branch" "$when" "$dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BB_APP/build-info.json"
note "building from $sha on $branch$([ "$dirty" = true ] && echo ' (uncommitted changes)')"

bb_start_engine
bb_compose_env
cd "$BB_APP" || die "no $BB_APP"

say "Rebuilding"
bb_compose up -d --build --remove-orphans || die "docker compose failed"
# The allowlist is bind-mounted as a single file and this copy replaced it: if the proxy now sees
# a different list, recreate it; otherwise a reconfigure (which keeps connections) is enough.
if bb_compose exec -T egress cat /etc/squid/allowlist.txt 2>/dev/null | diff -q - egress/allowlist.txt >/dev/null 2>&1; then
  bb_compose exec -T egress squid -k reconfigure -f /etc/squid/squid.conf 2>/dev/null || bb_compose restart egress
else
  say "allowlist changed: recreating the proxy so it sees the new file"
  bb_compose up -d --force-recreate egress
fi
bb_compose ps
say "Deployed. http://localhost:$BB_PORT"
