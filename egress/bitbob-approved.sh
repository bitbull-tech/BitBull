#!/bin/sh
# Squid external ACL helper: for a host that isn't on allowlist.txt, ask BitBob whether the
# user has approved it (Settings -> Network, or an agent request they allowed).
# One host per line in, OK or ERR out. Anything unexpected is ERR: the proxy fails closed.
BITBOB_URL="${BITBOB_URL:-http://bitbob-agent:8787}"
while read -r host rest; do
  case "$host" in
    ''|*[!A-Za-z0-9.-]*) echo ERR; continue ;;
  esac
  r=$(curl -s -m 3 --noproxy '*' "$BITBOB_URL/internal/egress/check?host=$host" 2>/dev/null)
  if [ "$r" = "OK" ]; then echo OK; else echo ERR; fi
done
